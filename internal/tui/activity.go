package tui

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

type activityMsg struct {
	instance        string
	version, target uint64
	entries         []*v1.ActivityReport
	events          []*v1.JobEvent
	next            uint64
	more            bool
	err             error
}

type activityHistory struct {
	instance                     string
	version, cursor, seenThrough uint64
	loading                      bool
	entries                      []*v1.ActivityReport
	events                       []*v1.JobEvent
	err                          error
}

func (m *Model) loadActivity() tea.Cmd {
	if m.panel != activityPanel || m.instance == "" {
		return nil
	}

	if m.agentActivity.instance != m.instance {
		m.agentActivity = activityHistory{instance: m.instance, version: m.agentActivity.version + 1}
	}

	if m.agentActivity.loading || (m.agentActivity.seenThrough >= m.snapshot.GetSequence() && m.agentActivity.err == nil) {
		return nil
	}

	m.agentActivity.loading = true
	m.resizeContent()
	instance, version, cursor, target := m.instance, m.agentActivity.version, m.agentActivity.cursor, m.snapshot.GetSequence()

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
		defer cancel()

		response, err := m.api.RPC.ListActivity(ctx, connect.NewRequest(&v1.ListActivityRequest{AfterSequence: cursor}))
		if err != nil {
			return activityMsg{instance: instance, version: version, target: target, err: err}
		}

		return activityMsg{instance: instance, version: version, target: target, entries: response.Msg.GetActivities(), events: response.Msg.GetEvents(), next: response.Msg.GetNextSequence(), more: response.Msg.GetHasMore()}
	}
}

func (m *Model) applyActivity(msg activityMsg) tea.Cmd {
	if msg.instance != m.instance || msg.version != m.agentActivity.version {
		return nil
	}

	m.agentActivity.loading = false
	m.agentActivity.err = msg.err

	if msg.err != nil {
		m.resizeContent()
		return nil
	}

	if msg.next < m.agentActivity.cursor || (msg.more && msg.next == m.agentActivity.cursor) {
		m.agentActivity.err = errors.New("activity page did not advance its cursor")
		m.resizeContent()

		return nil
	}

	for _, entry := range msg.entries {
		if entry.GetSequence() > m.agentActivity.cursor {
			m.agentActivity.entries = append(m.agentActivity.entries, entry)
		}
	}

	for _, event := range msg.events {
		if event.GetSequence() > m.agentActivity.cursor {
			m.agentActivity.events = append(m.agentActivity.events, event)
		}
	}

	m.agentActivity.cursor = msg.next
	if !msg.more {
		m.agentActivity.seenThrough = msg.target
	}

	m.resizeContent()

	if msg.more {
		return m.loadActivity()
	}

	return nil
}

func activityTitle(name v1.ActivityName) string {
	switch name {
	case v1.ActivityName_ACTIVITY_NAME_MERGE_PR:
		return "Merge PR"
	case v1.ActivityName_ACTIVITY_NAME_RUN_CHECKS:
		return "Run checks"
	case v1.ActivityName_ACTIVITY_NAME_RESOLVE_CONFLICT:
		return "Resolve conflict"
	case v1.ActivityName_ACTIVITY_NAME_SUMMARIZE_PR:
		return "Summarize PR"
	case v1.ActivityName_ACTIVITY_NAME_NOTIFY_AGENT:
		return "Notify agent"
	case v1.ActivityName_ACTIVITY_NAME_UNSPECIFIED:
		return "Unspecified operation"
	default:
		return "Unknown operation"
	}
}

func activityOutcome(outcome v1.ActivityOutcome) string {
	switch outcome {
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_ATTEMPTED:
		return "attempt reported"
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_SUCCEEDED:
		return "success reported"
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_FAILED:
		return "failure reported"
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_UNCERTAIN:
		return "outcome uncertain"
	case v1.ActivityOutcome_ACTIVITY_OUTCOME_UNSPECIFIED:
		return "outcome unspecified"
	default:
		return "outcome unknown"
	}
}

func (m *Model) activityMarkdown() string {
	history := m.agentActivity
	result := "# Agent activity\n\nAll sessions · newest first · UTC\n\nCoordinator events and agent reports. Agent-reported execution is not independently verified by this log.\n\n"

	if history.err != nil {
		result += "**History incomplete:** " + safe(history.err.Error()) + "\n\nPress **u** to retry.\n\n"
	}

	if history.loading {
		result += "Loading activity history…\n\n"
	}

	if len(history.entries) == 0 && len(history.events) == 0 {
		return result + "No agent activity recorded yet. Use `record-activity --help` from an agent session to report a named operation."
	}

	for _, item := range activityItems(history) {
		if item.event != nil {
			event := item.event
			result += "## Coordinator · " + strings.ReplaceAll(safe(event.GetKind()), "_", " ") + "\n\n"
			result += fmt.Sprintf("%s · #%d\n\n", time.UnixMilli(event.GetAtMs()).UTC().Format("2006-01-02 15:04:05 UTC"), event.GetSequence())
			result += safe(event.GetDetail()) + "\n\n"

			for _, reference := range []string{event.GetPrId(), event.GetActionId(), event.GetJobId()} {
				if reference != "" {
					result += "`" + safe(reference) + "` "
				}
			}

			result += "\n\n---\n\n"

			continue
		}

		entry := item.report
		report := entry.GetReport()
		actor := report.GetActor()
		result += "## " + activityTitle(report.GetName()) + " · " + activityOutcome(report.GetOutcome()) + "\n\n"
		result += fmt.Sprintf("%s · #%d\n\n", time.UnixMilli(entry.GetRecordedAtMs()).UTC().Format("2006-01-02 15:04:05 UTC"), entry.GetSequence())
		identity := safe(actor.GetHarness())

		if actor.GetVersion() != "" {
			identity += " " + safe(actor.GetVersion())
		}

		result += "**" + identity + "** · session `" + safe(actor.GetSessionId()) + "`\n\n"
		if actor.GetModel() != "" {
			result += "Model: `" + safe(actor.GetModel()) + "`\n\n"
		}

		result += safe(report.GetDetail()) + "\n\n"
		if report.GetPrUrl() != "" {
			result += safe(report.GetPrUrl()) + "\n\n"
		}

		if report.GetEvidenceUrl() != "" {
			result += "Evidence: " + safe(report.GetEvidenceUrl()) + "\n\n"
		}

		name := strings.ToLower(strings.TrimPrefix(report.GetName().String(), "ACTIVITY_NAME_"))
		result += "`" + name + "` · operation `" + safe(report.GetOperationId()) + "`\n\n---\n\n"
	}

	return result
}

type activityItem struct {
	sequence uint64
	report   *v1.ActivityReport
	event    *v1.JobEvent
}

func activityItems(history activityHistory) []activityItem {
	items := make([]activityItem, 0, len(history.entries)+len(history.events))
	for _, entry := range history.entries {
		items = append(items, activityItem{sequence: entry.GetSequence(), report: entry})
	}

	for _, event := range history.events {
		items = append(items, activityItem{sequence: event.GetSequence(), event: event})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].sequence > items[j].sequence })

	return items
}
