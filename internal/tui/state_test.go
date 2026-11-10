package tui

import (
	"reflect"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/diagram"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func TestObservedDiagramPreservesRetryTrace(t *testing.T) {
	allowed := []*v1.StateTransition{
		{From: v1.JobStatus_JOB_STATUS_QUEUED, To: v1.JobStatus_JOB_STATUS_RUNNING},
		{From: v1.JobStatus_JOB_STATUS_RUNNING, To: v1.JobStatus_JOB_STATUS_FAILED},
		{From: v1.JobStatus_JOB_STATUS_FAILED, To: v1.JobStatus_JOB_STATUS_QUEUED},
		{From: v1.JobStatus_JOB_STATUS_RUNNING, To: v1.JobStatus_JOB_STATUS_SUCCEEDED},
	}
	path := []string{"queued", "running", "failed", "queued", "running", "succeeded"}

	graph := observedDiagram(path, "succeeded", allowed)
	if !reflect.DeepEqual(graph.Trace.Steps, []int{0, 1, 2, 0, 3}) {
		t.Fatalf("retry trace lost chronology: %v", graph.Trace.Steps)
	}

	if graph.Active != "succeeded" || !graph.States[3].Final {
		t.Fatalf("completion missing: %+v", graph)
	}

	if graph.States[2].Final || graph.States[2].Outcome != diagram.OutcomeError {
		t.Fatalf("retryable failure became terminal: %+v", graph.States[2])
	}

	for _, mode := range []theme.Mode{theme.Dark, theme.Light, theme.Contrast, theme.Mono} {
		rendered, err := graph.View(126, theme.New(mode))
		if err != nil {
			t.Fatal(err)
		}

		if !strings.Contains(rendered, "succeeded") {
			t.Fatal("missing outcome")
		}
	}

	partial := observedDiagram(path[:3], "succeeded", allowed)
	if partial.Active != "" {
		t.Fatal("partial history claims current state")
	}

	if _, err := partial.View(126, theme.New(theme.Dark)); err != nil {
		t.Fatal(err)
	}
}

func TestStateDiagramWidthAndScrollableHistory(t *testing.T) {
	for _, mode := range []theme.Mode{theme.Dark, theme.Light, theme.Contrast, theme.Mono} {
		m := model(t, mode)
		m.panel = statePanel

		m.history = historyState{job: m.selected, instance: m.instance}
		for i, kind := range []string{"queued", "running", "conflicted", "resolving", "succeeded"} {
			m.history.events = append(m.history.events, &v1.JobEvent{Sequence: uint64(i + 1), Kind: kind})
		}

		for _, width := range []int{126, 76, 24, 1} {
			rendered := strings.ReplaceAll(ansi.Strip(m.stateView(width)), "\n", "")
			if !strings.Contains(rendered, "Transition history") || !strings.Contains(rendered, "succeeded") {
				t.Fatalf("state history lost at width %d: %q", width, rendered)
			}
		}

		m.Resize(layout.Size{Width: 80, Height: 32})

		if m.result.TotalLineCount() <= m.result.Height() {
			t.Fatal("vertical graph should remain scrollable")
		}

		m.result.GotoBottom()

		if m.result.YOffset() == 0 {
			t.Fatal("history cannot be reached")
		}
	}
}
