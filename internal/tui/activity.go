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
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/feedback"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

const activityPageSize = 50

type activityRenderCache struct {
	source, rendered string
	width            int
	valid            bool
}

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
	page                         int
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
		m.activityRender.valid = false
		m.resizeContent()
	}

	if m.agentActivity.loading || (m.agentActivity.seenThrough >= m.snapshot.GetSequence() && m.agentActivity.err == nil) {
		return nil
	}

	m.agentActivity.loading = true
	m.activityRender.valid = false
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
	m.activityRender.valid = false

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

func (m *Model) activityContent() string {
	history := m.agentActivity

	parts := []string{text.Badge("Agent activity", m.theme), m.muted("Newest first · unchanged PR checks grouped · UTC"), text.Label("Coordinator observations and agent reports. Reported success is not independent verification.", m.theme)}
	if history.err != nil {
		parts = append(parts, feedback.Warn.View(text.Normal, m.theme)+" History incomplete: "+text.Label(safe(history.err.Error()), m.theme), text.KeyHint("u", "retry", m.theme))
	}

	if history.loading {
		parts = append(parts, text.PendingWithPresentation(text.GlyphAndLabel, m.theme)+" Loading activity history…")
	}

	items := activityItems(history)
	if len(items) == 0 {
		return strings.Join(append(parts, "No agent activity recorded yet. Use record-activity --help from an agent session."), "\n")
	}

	start := min(history.page*activityPageSize, ((len(items)-1)/activityPageSize)*activityPageSize)

	end := min(start+activityPageSize, len(items))
	if len(items) > activityPageSize {
		parts = append(parts, text.Pill(fmt.Sprintf("%d–%d of %d", start+1, end, len(items)), text.Neutral, m.theme, text.Dim)+" "+text.KeyHint("h", "older", m.theme)+" · "+text.KeyHint("l", "newer", m.theme))
	}

	parts = append(parts, "")

	for _, item := range items[start:end] {
		if item.event != nil {
			event := item.event
			context := event.GetActionContext()

			row := m.presentEvent(event)

			title := text.Log(row.title, m.theme)
			if context != nil {
				title += " " + text.Pill(stateName(context.GetState().String(), "ACTION_STATE_"), actionTone(context.GetState()), m.theme, text.Normal)
			}

			parts = append(parts, title, m.activityTime(event.GetAtMs()), row.detail)
			if row.prURL != "" {
				parts = append(parts, m.link(row.prURL))
			} else if event.GetPrId() != "" {
				parts = append(parts, m.muted("PR context unavailable"))
			}

			if context != nil {
				if context.GetActorAgentId() != "" {
					parts = append(parts, text.Badge(safe(context.GetActorHarness()), m.theme)+" "+text.Label(sessionContext(context.GetActorLabel(), "", context.GetActorSessionId()), m.theme))
				} else {
					parts = append(parts, m.muted("Coordinator-observed transition."))
				}
			} else if event.GetKind() == "action_progress" {
				parts = append(parts, text.Pill("transition unknown", text.Neutral, m.theme, text.Dim)+" Legacy event: transition state and actor were not recorded.")
			}

			parts = append(parts, "")

			continue
		}

		entry := item.report
		report := entry.GetReport()
		actor := report.GetActor()
		parts = append(parts, text.Log(activityTitle(report.GetName()), m.theme)+" "+text.Pill(activityOutcome(report.GetOutcome()), outcomeTone(report.GetOutcome()), m.theme, text.Normal), m.activityTime(entry.GetRecordedAtMs()), text.Label(safe(report.GetDetail()), m.theme))

		identity := safe(actor.GetHarness())
		if actor.GetVersion() != "" {
			identity += " " + safe(actor.GetVersion())
		}

		parts = append(parts, text.Badge(identity, m.theme)+" "+text.Label(sessionContext(actor.GetLabel(), actor.GetCwd(), actor.GetSessionId()), m.theme))
		if actor.GetModel() != "" {
			parts = append(parts, m.field("Model", actor.GetModel()))
		}

		if report.GetPrUrl() != "" {
			parts = append(parts, m.link(report.GetPrUrl()))
		}

		if report.GetEvidenceUrl() != "" {
			parts = append(parts, m.muted("Evidence: ")+m.link(report.GetEvidenceUrl()))
		}

		parts = append(parts, "")
	}

	return strings.Join(parts, "\n")
}

func (m *Model) activityTime(at int64) string {
	stamp := time.UnixMilli(at).UTC()
	return m.muted(stamp.Format("Jan 2, 2006") + " · " + stamp.Format("15:04 UTC"))
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

	visible := items[:0]
	for _, item := range items {
		if len(visible) > 0 && repeatedObservation(visible[len(visible)-1], item) {
			continue
		}

		visible = append(visible, item)
	}

	return visible
}

func (m *Model) activitySource() string {
	if !m.activityRender.valid {
		m.activityRender.source = m.activityContent()
		m.activityRender.width = -1
		m.activityRender.valid = true
	}

	return m.activityRender.source
}

func (m *Model) renderedActivity(width int) string {
	source := m.activitySource()
	if m.activityRender.width != width {
		m.activityRender.rendered = ansi.Wrap(source, width, " ")
		m.activityRender.width = width
	}

	return m.activityRender.rendered
}

func (m *Model) moveActivityPage(delta int) {
	count := len(m.agentActivity.entries) + len(m.agentActivity.events)

	page := min(max(0, m.agentActivity.page+delta), max(0, (count-1)/activityPageSize))
	if page == m.agentActivity.page {
		return
	}

	m.agentActivity.page = page
	m.activityRender.valid = false
	m.result.GotoTop()
	m.resizeContent()
}
