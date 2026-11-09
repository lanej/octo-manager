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
	"github.com/lanej/octo-manager/internal/client"
)

func example() *v1.Snapshot {
	return &v1.Snapshot{
		InstanceId: "fixture", Scheduler: v1.SchedulerState_SCHEDULER_STATE_RUNNING, Worker: v1.WorkerState_WORKER_STATE_IDLE,
		Jobs: []*v1.Job{{Id: "fixture-job", Status: v1.JobStatus_JOB_STATUS_SUCCEEDED, Task: &v1.Task{Kind: &v1.Task_ResolveConflict{ResolveConflict: &v1.ResolveConflictTask{}}}, ResultMarkdown: new("# Resolved\n\n**Combined policy** in `retry-policy.json`.\n\n```json\n{\"maxAttempts\":3,\"timeoutSeconds\":60}\n```\n\n\x1b[2JVisible text")}},
	}
}

func model(t *testing.T, mode theme.Mode) *Model {
	t.Helper()

	m := New(context.Background(), client.New("/nonexistent/octo-manager.sock"), theme.New(mode))
	m.snapshot = example()
	m.ensureSelection()
	t.Cleanup(func() {
		if err := m.Close(); err != nil {
			t.Error(err)
		}
	})

	return m
}

func TestMarkdownAndTerminalGeometry(t *testing.T) {
	t.Parallel()

	for _, mode := range []theme.Mode{theme.Dark, theme.Light, theme.Contrast, theme.Mono} {
		m := model(t, mode)
		for _, size := range []layout.Size{{Width: 132, Height: 40}, {Width: 96, Height: 24}, {Width: 80, Height: 32}, {Width: 40, Height: 12}, {Width: 12, Height: 5}, {Width: 1, Height: 1}} {
			m.Resize(size)
			view := m.View()

			lines := strings.Split(view, "\n")
			if len(lines) != size.Height {
				t.Fatalf("%v: %d rows", size, len(lines))
			}

			for _, line := range lines {
				if ansi.StringWidth(line) > size.Width {
					t.Fatalf("%v: line exceeds width: %q", size, line)
				}
			}

			if size.Width >= 96 && (!strings.Contains(view, "Combined policy") || strings.Contains(view, "**Combined policy**") || strings.Contains(view, "```")) {
				t.Fatalf("Markdown not formatted: %q", view)
			}

			if strings.Contains(view, "\x1b[2J") {
				t.Fatal("untrusted clear-screen sequence rendered")
			}

			if size.Width == 12 && !strings.Contains(lines[len(lines)-1], "q quit") {
				t.Fatal("quit hint hidden")
			}
		}
	}
}

func TestIndependentScrollAndResizeFocus(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)

	m.snapshot.Jobs[0].ResultMarkdown = new(strings.Repeat("A distinct result paragraph.\n\n", 60))
	for i := range 25 {
		m.snapshot.RecentEvents = append(m.snapshot.RecentEvents, &v1.JobEvent{Sequence: uint64(i + 1), JobId: "fixture-job", Kind: "tool", Detail: "read_conflict"})
	}

	m.Resize(layout.Size{Width: 132, Height: 40})
	m.Update(tea.KeyPressMsg{Code: ']', Text: "]"})

	if m.result.YOffset() != 3 {
		t.Fatal("result did not scroll")
	}

	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})

	if m.focus.Current() != "activity" {
		t.Fatal("activity did not receive focus")
	}

	m.Update(tea.KeyPressMsg{Code: '[', Text: "["})

	if m.result.YOffset() != 3 {
		t.Fatal("activity scrolling moved result")
	}

	m.Resize(layout.Size{Width: 80, Height: 16})

	if m.focus.Current() != "result" {
		t.Fatal("focus stayed on hidden activity")
	}

	m.Update(tea.KeyPressMsg{Code: ']', Text: "]"})

	if m.result.YOffset() <= 3 {
		t.Fatal("result cannot scroll after resize")
	}
}

type rejectingWatch struct {
	octomanagerv1connect.UnimplementedSchedulerServiceHandler
	code connect.Code
}

func (s rejectingWatch) Watch(context.Context, *connect.Request[v1.WatchRequest], *connect.ServerStream[v1.WatchResponse]) error {
	return connect.NewError(s.code, errors.New("invalid cursor or instance"))
}

func TestRejectedWatchResynchronizes(t *testing.T) {
	t.Parallel()

	for _, code := range []connect.Code{connect.CodeOutOfRange, connect.CodeFailedPrecondition} {
		m := model(t, theme.Dark)
		m.instance, m.cursor, m.watching = "fixture", 999, true
		m.snapshot.Sequence = 999
		_, handler := octomanagerv1connect.NewSchedulerServiceHandler(rejectingWatch{code: code})
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		rpc := octomanagerv1connect.NewSchedulerServiceClient(server.Client(), server.URL)

		stream, err := rpc.Watch(t.Context(), connect.NewRequest(&v1.WatchRequest{InstanceId: "fixture", AfterSequence: 999}))
		if err != nil {
			t.Fatal(err)
		}

		next := m.Update(watchMsg{instance: "fixture", stream: stream})
		if next == nil {
			t.Fatal("stream receive was not scheduled")
		}

		closeCommand := m.Update(next())
		if closeCommand == nil {
			t.Fatal("terminated stream was not closed")
		}

		m.Update(closeCommand())

		if m.watching {
			t.Fatal("rejected stream still watching")
		}

		if m.instance != "" {
			t.Fatal("rejected cursor does not request a fresh snapshot")
		}

		fresh := example()
		fresh.Sequence = 12
		m.Update(snapshotMsg{snapshot: fresh})

		if m.instance != "fixture" || m.cursor != 12 {
			t.Fatal("fresh snapshot did not replace stale history cursor")
		}
	}
}

func TestRetryOutputExcludesPreviousAttempt(t *testing.T) {
	t.Parallel()

	job := &v1.Job{Status: v1.JobStatus_JOB_STATUS_RUNNING, Attempts: []*v1.Attempt{{StartedAtMs: 10}, {StartedAtMs: 30}}}

	events := []*v1.JobEvent{{AtMs: 11, Kind: "progress", Detail: "old output"}, {AtMs: 12, Kind: "conflicted", Detail: "old conflict"}}
	if got := markdown(job, events); got != "Waiting for worker output…" {
		t.Fatalf("retry shows previous attempt: %q", got)
	}

	events = append(events, &v1.JobEvent{AtMs: 31, Kind: "conflicted", Detail: "current conflict"})
	if got := markdown(job, events); !strings.Contains(got, "current conflict") || strings.Contains(got, "old") {
		t.Fatalf("wrong conflict: %q", got)
	}

	events = append(events, &v1.JobEvent{AtMs: 32, Kind: "progress", Detail: "current output"})
	if got := markdown(job, events); got != "current output" {
		t.Fatalf("wrong progress: %q", got)
	}
}
