package tui

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
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
		stamp := time.UnixMilli(event.GetAtMs()).UTC().Format("01-02 15:04:05")
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

	if len(path) > 0 && path[len(path)-1] == statusLabel(job.GetStatus()) {
		path[len(path)-1] = m.theme.Heading().Render("[" + path[len(path)-1] + "]")
	}

	rows := []string{m.theme.Heading().Render("Observed state path")}
	if len(path) == 0 {
		rows = append(rows, "No persisted transitions loaded yet.")
	} else {
		rows = append(rows, ansi.Wrap(strings.Join(path, arrow), max(1, width), ""))
	}

	if record.loading {
		rows = append(rows, m.theme.Subtle().Render("Loading full history…"))
	}

	if record.err != nil {
		rows = append(rows, "History incomplete: "+safe(record.err.Error()))
	}

	rows = append(rows, "", m.theme.Heading().Render("Transition history · UTC · sequence order"))
	rows = append(rows, history...)
	rows = append(rows, "", m.theme.Heading().Render("Allowed state map · coordinator contract"))

	edges := map[v1.JobStatus][]v1.JobStatus{}
	for _, edge := range m.snapshot.GetAllowedTransitions() {
		edges[edge.GetFrom()] = append(edges[edge.GetFrom()], edge.GetTo())
		if _, ok := edges[edge.GetTo()]; !ok {
			edges[edge.GetTo()] = nil
		}
	}

	keys := make([]v1.JobStatus, 0, len(edges))
	for state := range edges {
		keys = append(keys, state)
	}

	slices.Sort(keys)

	for _, state := range keys {
		label := statusLabel(state)
		if state == job.GetStatus() {
			label = m.theme.Heading().Render("[" + label + "]")
		}

		targets := edges[state]
		if len(targets) == 0 {
			rows = append(rows, label+" (terminal)")
			continue
		}

		names := make([]string, 0, len(targets))
		for _, target := range targets {
			names = append(names, statusLabel(target))
		}

		rows = append(rows, ansi.Wrap(label+arrow+strings.Join(names, " | "), max(1, width), ""))
	}

	if len(edges) == 0 {
		rows = append(rows, "State contract unavailable from this coordinator.")
	}

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
			slot += " · exit observed " + time.UnixMilli(attempt.GetExitObservedAtMs()).UTC().Format("15:04:05 UTC")
		} else if attempt.WorkerPid != nil {
			slot += " · exit not observed"
		}

		if attempt.EndedAtMs != nil {
			first += fmt.Sprintf(" · %.1fs", float64(attempt.GetEndedAtMs()-attempt.GetStartedAtMs())/1000)
		}
	}

	return []string{first, slot}
}
