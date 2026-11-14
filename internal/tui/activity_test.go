package tui

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

		if size.Width >= 80 && (!strings.Contains(view, "ACTION") || (!strings.Contains(view, "success") || !strings.Contains(view, "reported")) || !strings.Contains(view, "codex 0.167.0")) {
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

	if !strings.Contains(ansi.Strip(m.activityContent()), "History incomplete") {
		t.Fatal("failed activity reads appear as complete history")
	}
}

func TestActivityWindowRefreshAndVisibleFocus(t *testing.T) {
	// rationale: AllocsPerRun requires the refresh measurement to run without parallel tests.
	m := model(t, theme.Dark)
	m.panel = activityPanel
	m.snapshot.Jobs = nil
	m.snapshot.Sequence = 3000
	m.instance = "fixture"

	m.agentActivity = activityHistory{instance: "fixture", cursor: 3000, seenThrough: 3000}
	for sequence := uint64(1); sequence <= 3000; sequence++ {
		m.agentActivity.entries = append(m.agentActivity.entries, &v1.ActivityReport{Sequence: sequence, Report: &v1.ActivityInput{
			Name: v1.ActivityName_ACTIVITY_NAME_RUN_CHECKS, Outcome: v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED,
			Actor: &v1.ActivityActor{Harness: "codex", SessionId: "caller"}, Detail: fmt.Sprintf("record-%04d-end", sequence),
		}})
	}

	m.Resize(layout.Size{Width: 132, Height: 40})

	latest := ansi.Strip(m.activitySource())
	if strings.Count(latest, "Run checks") != 50 || !strings.Contains(latest, "record-3000-end") || !strings.Contains(latest, "record-2951-end") || strings.Contains(latest, "record-2950-end") {
		t.Fatal("latest activity window omitted records or rendered outside its bound")
	}

	m.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})

	older := ansi.Strip(m.activitySource())
	if !strings.Contains(older, "record-2950-end") || !strings.Contains(older, "record-2901-end") || strings.Contains(older, "record-2951-end") {
		t.Fatal("older activity page overlaps or skips records")
	}

	m.Update(tea.KeyPressMsg{Code: 'l', Text: "l"})

	if ansi.Strip(m.activitySource()) != latest {
		t.Fatal("newer activity navigation did not return to the latest page")
	}

	allocations := testing.AllocsPerRun(3, func() { m.resizeContent() })
	if allocations > 100000 {
		t.Fatalf("unchanged activity refresh rebuilt content: %.0f allocations", allocations)
	}

	m.result.GotoTop()
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m.Update(tea.KeyPressMsg{Code: ']', Text: "]"})

	if m.focus.Current() != "result" || m.result.YOffset() == 0 {
		t.Fatal("Tab moved focus to a hidden pane instead of scrolling Activity")
	}

	m.Update(tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift})

	if m.focus.Current() != "result" {
		t.Fatal("Shift-Tab moved focus to a hidden pane")
	}

	m.applyActivity(activityMsg{instance: m.instance, version: m.agentActivity.version, target: 3000, next: 3000, err: errors.New("offline")})

	if !strings.Contains(m.activitySource(), "History incomplete") {
		t.Fatal("render cache hid an activity read error")
	}

	m.instance = "empty-replacement"
	m.snapshot.Sequence = 0
	m.loadActivity()

	if strings.Contains(m.activitySource(), "record-3000-end") || !strings.Contains(m.activitySource(), "No agent activity") {
		t.Fatal("cached activity survived a database instance replacement")
	}
}

func BenchmarkActivityRefresh(b *testing.B) {
	m := New(context.Background(), nil, theme.New(theme.Dark), time.Local)
	b.Cleanup(m.cancel)
	m.snapshot = &v1.Snapshot{}

	m.panel = activityPanel
	for sequence := uint64(1); sequence <= 3000; sequence++ {
		m.agentActivity.entries = append(m.agentActivity.entries, &v1.ActivityReport{Sequence: sequence, Report: &v1.ActivityInput{
			Name: v1.ActivityName_ACTIVITY_NAME_RUN_CHECKS, Outcome: v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED,
			Actor: &v1.ActivityActor{Harness: "codex", SessionId: "caller"}, Detail: "Strict TypeScript and Go checks completed successfully.",
		}})
	}

	m.Resize(layout.Size{Width: 132, Height: 40})
	b.ReportAllocs()

	for b.Loop() {
		m.resizeContent()
	}
}

func TestActivityShowsHistoricalActionContextAndLegacyGaps(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.agentActivity.events = []*v1.JobEvent{
		{Sequence: 1, Kind: "action_progress", Detail: "Merge conflict"},
		{Sequence: 2, Kind: "action_progress", Detail: "Merge conflict", ActionContext: &v1.ActionEventContext{State: v1.ActionState_ACTION_STATE_ACKNOWLEDGED, PrUrl: "https://github.com/owner/repo/pull/1", ActorAgentId: new("original"), ActorHarness: new("codex"), ActorSessionId: new("first"), ActorLabel: new("Original owner")}},
	}

	source := strings.Join(strings.Fields(ansi.Strip(m.activityContent())), " ")
	for _, expected := range []string{"acknowledged", "owner/repo#1", "codex", "Original owner", "unrecorded."} {
		if !strings.Contains(source, expected) {
			t.Fatalf("activity omitted %q", expected)
		}
	}
}

func TestActivityTableRetainsPerRecordDSTOffset(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)

	location, err := DisplayLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}

	m.location = location

	before, err := time.Parse(time.RFC3339, "2026-11-01T08:30:00Z")
	if err != nil {
		t.Fatal(err)
	}

	after, err := time.Parse(time.RFC3339, "2026-11-01T09:30:00Z")
	if err != nil {
		t.Fatal(err)
	}

	m.agentActivity.events = []*v1.JobEvent{{Sequence: 1, AtMs: before.UnixMilli(), Kind: "pr_observed"}, {Sequence: 2, AtMs: after.UnixMilli(), Kind: "pr_observed"}}
	m.Resize(layout.Size{Width: 208, Height: 111})

	view := ansi.Strip(m.activityContent())
	for _, want := range []string{"01:30:00 PDT -0700", "01:30:00 PST -0800"} {
		if !strings.Contains(view, want) {
			t.Fatalf("activity table lost DST distinction %q", want)
		}
	}
}
