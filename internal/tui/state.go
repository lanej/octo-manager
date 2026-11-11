package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/diagram"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func transitionStatus(kind string) (v1.JobStatus, bool) {
	value, ok := v1.JobStatus_value["JOB_STATUS_"+strings.ToUpper(kind)]
	return v1.JobStatus(value), ok && value != 0
}

func (m *Model) stateView(width int) string {
	job := m.job()
	if job == nil {
		return "Select a PR run to inspect its state."
	}

	arrow := " ─▶ "
	if m.theme.ASCII {
		arrow = " -> "
	}

	var path, history []string

	previous := "start"

	record := m.history
	if record.job != m.selected || record.instance != m.instance {
		record = historyState{}
	}

	for _, event := range record.events {
		state, ok := transitionStatus(event.GetKind())
		if !ok {
			continue
		}

		label := statusLabel(state)

		path = append(path, label)
		stamp := m.timestamp(event.GetAtMs(), "01-02 15:04:05 MST -0700")
		entry := fmt.Sprintf("#%d  %s  %s%s%s", event.GetSequence(), stamp, previous, arrow, label)

		detail := strings.Join(strings.Fields(safe(event.GetDetail())), " ")
		if event.GetKind() == "conflicted" {
			detail = "Git conflict detected"
		}

		if detail != "" {
			entry += " · " + detail
		}

		history = append(history, ansi.Wrap(entry, max(1, width), ""))
		previous = label
	}

	rows := []string{m.theme.Heading().Render("Observed state diagram · latest transition highlighted")}
	if len(path) == 0 {
		rows = append(rows, "No persisted transitions loaded yet.")
	} else {
		graph := observedDiagram(path, statusLabel(job.GetStatus()), m.snapshot.GetAllowedTransitions())
		if rendered, err := graph.View(max(1, width), m.theme); err == nil {
			rows = append(rows, rendered)
		} else {
			rows = append(rows, ansi.Wrap("Diagram unavailable: "+safe(err.Error()), max(1, width), ""), ansi.Wrap(strings.Join(path, arrow), max(1, width), ""))
		}
	}

	if record.loading {
		rows = append(rows, m.theme.Subtle().Render("Loading full history…"))
	}

	if record.err != nil {
		rows = append(rows, "History incomplete: "+safe(record.err.Error()))
	}

	rows = append(rows, "", m.theme.Heading().Render("Transition history · "+m.zoneLabel()+" · sequence order"))
	rows = append(rows, history...)

	return strings.Join(rows, "\n")
}

func (m *Model) workerLines() []string {
	slot := "Slot " + strings.ToLower(strings.TrimPrefix(m.snapshot.GetWorker().String(), "WORKER_STATE_"))
	if m.snapshot.GetRecoveryPid() != 0 {
		slot = fmt.Sprintf("Recovering · waiting for PID %d", m.snapshot.GetRecoveryPid())
	}

	job := m.job()
	if job == nil {
		return []string{slot}
	}

	item := m.currentSubject()
	run := 1

	for i, candidate := range item.jobs {
		if candidate.GetId() == job.GetId() {
			run = i + 1
		}
	}

	attempts := job.GetAttempts()
	status := text.Pill(statusLabel(job.GetStatus()), jobTone(job.GetStatus()), m.theme)

	first := fmt.Sprintf("Run %d/%d · %s · ", run, max(1, len(item.jobs)), jobTitle(job)) + status + fmt.Sprintf(" · attempt %d", len(attempts))
	if len(attempts) > 0 {
		attempt := attempts[len(attempts)-1]
		if attempt.WorkerPid != nil {
			slot += fmt.Sprintf(" · attempt PID %d", attempt.GetWorkerPid())
		}

		if attempt.ExitObservedAtMs != nil {
			slot += " · exit observed " + m.timestamp(attempt.GetExitObservedAtMs(), "15:04:05 MST -0700")
		} else if attempt.WorkerPid != nil {
			slot += " · exit not observed"
		}

		if attempt.EndedAtMs != nil {
			first += fmt.Sprintf(" · %.1fs", float64(attempt.GetEndedAtMs()-attempt.GetStartedAtMs())/1000)
		}
	}

	return []string{first, slot}
}

func observedDiagram(path []string, current string, allowed []*v1.StateTransition) diagram.StateDiagram {
	graph := diagram.StateDiagram{}
	states := map[string]bool{}
	edges := map[[2]string]int{}
	outgoing := map[string]bool{}
	known := map[string]bool{}

	for _, edge := range allowed {
		from, to := statusLabel(edge.GetFrom()), statusLabel(edge.GetTo())
		outgoing[from] = true
		known[from] = true
		known[to] = true
	}

	previous := ""

	for i, label := range path {
		if !states[label] {
			outcome := diagram.OutcomeNone
			if label == "succeeded" {
				outcome = diagram.OutcomeSuccess
			}

			if label == "failed" || label == "interrupted" {
				outcome = diagram.OutcomeError
			}

			graph.States = append(graph.States, diagram.State{ID: label, Label: label, Initial: i == 0 && label == "queued", Final: known[label] && !outgoing[label], Outcome: outcome})
			states[label] = true
		}

		if previous != "" {
			edge := [2]string{previous, label}

			index, ok := edges[edge]
			if !ok {
				index = len(graph.Transitions)
				edges[edge] = index
				graph.Transitions = append(graph.Transitions, diagram.Transition{From: edge[0], To: edge[1]})
			}

			graph.Trace.Steps = append(graph.Trace.Steps, index)
		}

		previous = label
	}

	if previous != "" && previous == current {
		graph.Active = current
	}

	return graph
}
