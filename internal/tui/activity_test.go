package tui

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
	"github.com/lanej/octo-manager/gen/octomanager/v1/octomanagerv1connect"
)

type activityService struct {
	octomanagerv1connect.UnimplementedSchedulerServiceHandler
	cursors chan uint64
}

func (s activityService) ListActivity(_ context.Context, request *connect.Request[v1.ListActivityRequest]) (*connect.Response[v1.ListActivityResponse], error) {
	cursor := request.Msg.GetAfterSequence()
	s.cursors <- cursor

	var entries []*v1.ActivityReport

	for sequence := cursor + 1; sequence <= min(cursor+200, 201); sequence++ {
		entries = append(entries, &v1.ActivityReport{Sequence: sequence, RecordedAtMs: 1794326090000, Report: &v1.ActivityInput{
			Name: v1.ActivityName_ACTIVITY_NAME_MERGE_PR, Outcome: v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED,
			Actor:  &v1.ActivityActor{Harness: "codex", SessionId: "caller", Version: new("0.167.0")},
			Detail: "Merged Octo PR after checking its exact head", OperationId: "merge-operation-1", PrUrl: new("https://github.com/lanej/octo-manager/pull/2"),
		}})
	}

	return connect.NewResponse(&v1.ListActivityResponse{Activities: entries, NextSequence: min(cursor+200, 201), HasMore: cursor+200 < 201}), nil
}

func TestAgentActivityPagesWithoutJobsAndFencesReconnect(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Jobs = nil
	m.instance = "fixture"
	m.snapshot.Sequence = 1
	service := activityService{cursors: make(chan uint64, 4)}
	_, handler := octomanagerv1connect.NewSchedulerServiceHandler(service)
	server := httptest.NewServer(handler)

	t.Cleanup(server.Close)
	m.api.RPC = octomanagerv1connect.NewSchedulerServiceClient(server.Client(), server.URL)

	command := m.Update(tea.KeyPressMsg{Code: '5', Text: "5"})
	if command == nil {
		t.Fatal("activity tab did not load without a job")
	}

	command = m.Update(command())
	if command == nil {
		t.Fatal("next activity page was not requested")
	}

	m.Update(command())

	if len(m.agentActivity.entries) != 201 || m.agentActivity.seenThrough != 1 || <-service.cursors != 0 || <-service.cursors != 200 {
		t.Fatal("activity paging omitted durable reports or used incorrect cursors")
	}

	for _, size := range []layout.Size{{Width: 132, Height: 40}, {Width: 80, Height: 32}, {Width: 40, Height: 16}} {
		m.Resize(size)
		view := ansi.Strip(m.View())

		for _, line := range strings.Split(view, "\n") {
			if ansi.StringWidth(line) > size.Width {
				t.Fatalf("activity view exceeds %d columns", size.Width)
			}
		}

		if size.Width >= 80 && (!strings.Contains(view, "Agent activity") || !strings.Contains(view, "success reported") || !strings.Contains(view, "codex 0.167.0")) {
			t.Fatal("activity view omits the named outcome or actor")
		}
	}

	m.snapshot.Sequence = 201
	m.snapshot.Jobs = example().GetJobs()
	m.selected = ""
	m.watching = true
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if m.panel != activityPanel {
		t.Fatal("a newly arrived PR switched away from global activity")
	}

	m.result.GotoTop()
	m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})

	if m.panel != activityPanel || m.result.YOffset() == 0 {
		t.Fatal("global activity navigation switched to PRs instead of scrolling")
	}

	if m.Update(tea.KeyPressMsg{Code: 'c', Text: "c"}) != nil && m.commandPending {
		t.Fatal("activity navigation issued a hidden job cancellation")
	}

	previousVersion := m.agentActivity.version
	m.instance = "restarted"
	m.snapshot.Sequence = 0
	m.loadActivity()
	m.Update(activityMsg{instance: "fixture", version: previousVersion, entries: []*v1.ActivityReport{{Sequence: 999}}, next: 999})

	if len(m.agentActivity.entries) != 0 {
		t.Fatal("late report from another database instance entered the activity view")
	}

	m.snapshot.Sequence = 1
	m.loadActivity()
	m.Update(activityMsg{instance: m.instance, version: m.agentActivity.version, target: 1, err: errors.New("offline")})

	if !strings.Contains(m.activityMarkdown(), "History incomplete") {
		t.Fatal("failed activity reads appear as complete history")
	}
}
