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

type historyService struct {
	octomanagerv1connect.UnimplementedSchedulerServiceHandler
	cursors chan uint64
}

func (s historyService) ListEvents(_ context.Context, request *connect.Request[v1.ListEventsRequest]) (*connect.Response[v1.ListEventsResponse], error) {
	cursor := request.Msg.GetAfterSequence()
	s.cursors <- cursor

	var events []*v1.JobEvent

	switch cursor {
	case 0:
		for i := range 200 {
			kind := "tool"
			if i == 0 {
				kind = "queued"
			}

			if i == 1 {
				kind = "running"
			}

			events = append(events, &v1.JobEvent{Sequence: uint64(i + 1), JobId: request.Msg.GetJobId(), Kind: kind})
		}
	case 200:
		events = append(events, &v1.JobEvent{Sequence: 201, JobId: request.Msg.GetJobId(), Kind: "succeeded"})
	}

	return connect.NewResponse(&v1.ListEventsResponse{Events: events}), nil
}

func TestFullHistoryPagesAndFencesSelection(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.instance = "fixture"
	m.snapshot.Sequence = 201
	service := historyService{cursors: make(chan uint64, 4)}
	_, handler := octomanagerv1connect.NewSchedulerServiceHandler(service)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	m.api.RPC = octomanagerv1connect.NewSchedulerServiceClient(server.Client(), server.URL)

	command := m.loadHistory()
	if command == nil {
		t.Fatal("full history not requested")
	}

	command = m.Update(command())
	if command == nil {
		t.Fatal("second event page not requested")
	}

	m.Update(command())

	if len(m.history.events) != 201 || m.history.seenThrough != 201 || <-service.cursors != 0 || <-service.cursors != 200 {
		t.Fatal("history pages lost events or used wrong cursors")
	}

	view := m.stateView(90)
	if !strings.Contains(view, "start ─▶ queued") || !strings.Contains(view, "running ─▶ succeeded") {
		t.Fatal("old transitions missing beyond recent snapshot")
	}

	oldVersion := m.history.version
	oldJob := m.selected
	next := prJob("new-run", "https://github.com/owner/repo/pull/1")
	m.snapshot.Jobs = append(m.snapshot.Jobs, next)
	m.panel = statePanel
	m.selectJob(next)
	m.panel = statePanel
	m.Resize(layout.Size{Width: 132, Height: 40})

	if strings.Contains(ansi.Strip(m.View()), "start ─▶ queued") {
		t.Fatal("old run history visible while new history pending")
	}

	m.Update(historyMsg{job: oldJob, instance: "fixture", version: oldVersion, target: 201, events: []*v1.JobEvent{{Sequence: 202, JobId: oldJob, Kind: "failed"}}})

	if len(m.history.events) != 0 {
		t.Fatal("late history crossed selected-run boundary")
	}

	m.selectJob(m.snapshot.Jobs[0])
	m.Update(historyMsg{job: oldJob, instance: "fixture", version: oldVersion, target: 201, events: []*v1.JobEvent{{Sequence: 202, JobId: oldJob, Kind: "failed"}}})

	if len(m.history.events) != 0 {
		t.Fatal("late response survived reselecting the same run")
	}
}

func TestReviewsAndWorkerStateStayDistinct(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	address := "https://github.com/owner/repo/pull/1"
	job := prJob("run", address)
	job.Attempts = []*v1.Attempt{{Number: 1, WorkerPid: new(int64(42)), ExitObservedAtMs: new(int64(1000))}}
	m.snapshot.Jobs = []*v1.Job{job}
	m.selected = job.GetId()
	m.panel = reviewsPanel
	m.Update(reviewMsg{url: address, details: &v1.PullRequestDetails{Title: "Fix cancellation", State: "open", HeadSha: "current", ObservedAtMs: 2000, MayHaveMoreMessages: true, Messages: []*v1.ReviewMessage{{Author: "reviewer", State: "CHANGES_REQUESTED", BodyMarkdown: "Keep cancellation ahead of late success.", CommitSha: "earlier", BodyTruncated: true}}}})
	m.Resize(layout.Size{Width: 132, Height: 40})

	view := ansi.Strip(m.View())
	for _, expected := range []string{"changes requested", "Fix cancellation", "Slot idle", "Run 1/1", "succeeded"} {
		if !strings.Contains(view, expected) {
			t.Fatalf("missing %q in view:\n%s", expected, view)
		}
	}

	if strings.Contains(view, address) || !strings.Contains(view, "owner/repo#1") || strings.Contains(view, "A completed summary") {
		t.Fatal("duplicate PR identity or worker output mixed into reviews")
	}

	content := m.reviewsMarkdown()
	if !strings.Contains(content, "Partial history") || !strings.Contains(content, "earlier commit") || !strings.Contains(content, "Message truncated") {
		t.Fatal("review limits or stale commit hidden")
	}

	m.Update(reviewMsg{url: address, err: errors.New("network unavailable")})

	if !strings.Contains(m.reviewsMarkdown(), "network unavailable") || !strings.Contains(m.reviewsMarkdown(), "Fix cancellation") {
		t.Fatal("refresh failure discarded last observed messages")
	}

	m.Update(tea.KeyPressMsg{Code: '2', Text: "2"})

	if !strings.Contains(ansi.Strip(m.View()), "A completed summary") || strings.Contains(ansi.Strip(m.View()), "changes requested") {
		t.Fatal("output view did not remain separate")
	}

	m.Update(reviewMsg{url: "https://github.com/other/repo/pull/1", details: &v1.PullRequestDetails{Title: "Other PR"}})

	if strings.Contains(ansi.Strip(m.View()), "Other PR") {
		t.Fatal("late review response crossed PR boundary")
	}
}
