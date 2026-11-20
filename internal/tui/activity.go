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
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
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
	before          uint64
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
	oldest                       uint64
	hasOlder                     bool
	loaded                       bool
	retryBefore                  uint64
	cursors                      []uint64
	shownPage                    int
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

	if m.agentActivity.loading {
		return nil
	}

	if m.agentActivity.err != nil {
		return nil
	}

	if m.agentActivity.page > 0 || (m.agentActivity.seenThrough >= m.snapshot.GetSequence() && (m.agentActivity.loaded || m.agentActivity.cursor != 0 || m.agentActivity.seenThrough != 0)) {
		return nil
	}

	return m.requestActivity(m.snapshot.GetSequence() + 1)
}

func (m *Model) requestActivity(before uint64) tea.Cmd {
	m.agentActivity.loading = true

	m.agentActivity.version++
	if m.agentActivity.page == 0 {
		m.agentActivity.cursors = []uint64{before}
	}

	m.activityRender.valid = false
	m.resizeContent()
	instance, version, target := m.instance, m.agentActivity.version, m.snapshot.GetSequence()

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
		defer cancel()

		response, err := m.api.RPC.ListActivity(ctx, connect.NewRequest(&v1.ListActivityRequest{BeforeSequence: new(before), Limit: activityPageSize}))
		if err != nil {
			return activityMsg{instance: instance, version: version, target: target, before: before, err: err}
		}

		return activityMsg{instance: instance, version: version, target: target, before: before, entries: response.Msg.GetActivities(), events: response.Msg.GetEvents(), next: response.Msg.GetNextSequence(), more: response.Msg.GetHasMore()}
	}
}

func (m *Model) applyActivity(msg activityMsg) tea.Cmd {
	if msg.instance != m.instance || msg.version != m.agentActivity.version {
		return nil
	}

	m.agentActivity.loading = false
	m.agentActivity.err = msg.err
	m.agentActivity.retryBefore = msg.before

	m.activityRender.valid = false
	if msg.err != nil {
		m.resizeContent()
		return nil
	}

	if msg.before == 0 || msg.next >= msg.before || (msg.more && msg.next == 0) || len(msg.entries)+len(msg.events) > activityPageSize {
		m.agentActivity.err = errors.New("activity page exceeded its bound or did not advance its cursor")
		m.resizeContent()

		return nil
	}
	// Replace the visible page. Durable history stays on the coordinator.
	m.agentActivity.entries = msg.entries
	m.agentActivity.events = msg.events
	m.agentActivity.oldest = msg.next
	m.agentActivity.hasOlder = msg.more
	m.agentActivity.loaded = true

	m.agentActivity.shownPage = m.agentActivity.page
	if m.agentActivity.page == 0 {
		m.agentActivity.cursor = msg.target
		m.agentActivity.seenThrough = msg.target
	}

	m.resizeContent()

	return nil
}

func (m *Model) refreshActivity() tea.Cmd {
	if m.instance == "" {
		return nil
	}

	if m.agentActivity.instance != m.instance {
		return m.loadActivity()
	}

	if m.agentActivity.loading {
		return nil
	}

	if m.agentActivity.err != nil {
		return m.requestActivity(m.agentActivity.retryBefore)
	}

	m.agentActivity.page = 0
	m.result.GotoTop()

	return m.requestActivity(m.snapshot.GetSequence() + 1)
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

type activityLogRow struct {
	at               int64
	subject, message string
	prURL            string
}

func oneLine(value string) string { return strings.Join(strings.Fields(value), " ") }

func (m *Model) activityRows() []activityLogRow {
	items := activityItems(m.agentActivity)

	rows := make([]activityLogRow, 0, min(activityPageSize, len(items)))
	for _, item := range items[:min(activityPageSize, len(items))] {
		if event := item.event; event != nil {
			presentation := m.presentEvent(event)
			context := event.GetActionContext()

			subject := "coordinator"
			if presentation.prURL != "" {
				subject = m.link(presentation.prURL)
			} else if event.GetPrId() != "" {
				subject = "PR context unavailable"
			}

			message := text.Log(presentation.title, m.theme)
			if context != nil {
				message += " · " + text.Pill(stateName(context.GetState().String(), "ACTION_STATE_"), actionTone(context.GetState()), m.theme, text.Normal)
				if context.GetActorAgentId() != "" {
					message += " · " + safe(context.GetActorHarness()) + " " + sessionContext(context.GetActorLabel(), "", context.GetActorSessionId())
				}
			} else if event.GetKind() == "action_progress" {
				message += " · transition unknown · Legacy event: transition state and actor were not recorded."
			}

			if presentation.detail != "" {
				message += " · " + presentation.detail
			}

			rows = append(rows, activityLogRow{at: event.GetAtMs(), subject: subject, prURL: presentation.prURL, message: oneLine(message)})

			continue
		}

		entry := item.report
		report := entry.GetReport()
		actor := report.GetActor()

		identity := safe(actor.GetHarness())
		if actor.GetVersion() != "" {
			identity += " " + safe(actor.GetVersion())
		}

		identity += " " + sessionContext(actor.GetLabel(), actor.GetCwd(), actor.GetSessionId())

		subject := sessionContext(actor.GetLabel(), actor.GetCwd(), actor.GetSessionId())
		if report.GetPrUrl() != "" {
			subject = m.link(report.GetPrUrl())
		}

		message := text.Pill(activityOutcome(report.GetOutcome()), outcomeTone(report.GetOutcome()), m.theme, text.Normal) + " · " + text.Log(activityTitle(report.GetName()), m.theme)
		message += " · " + safe(report.GetDetail())

		message += " · " + identity
		if actor.GetModel() != "" {
			message += " · model " + safe(actor.GetModel())
		}

		if report.GetEvidenceUrl() != "" {
			message += " · Evidence: " + m.link(report.GetEvidenceUrl())
		}

		rows = append(rows, activityLogRow{at: entry.GetRecordedAtMs(), subject: oneLine(subject), prURL: report.GetPrUrl(), message: oneLine(message)})
	}

	return rows
}

func (m *Model) activitySubject(row activityLogRow, width int) string {
	if row.prURL != "" {
		link, err := webLink(row.prURL)
		if err == nil {
			if _, label := parsePRURL(row.prURL); label != "" {
				link.Label = label
			}

			marker := strings.LastIndex(link.Label, "#")
			if marker >= 0 && ansi.StringWidth(link.Label) > width {
				suffix := link.Label[marker:]
				link.Label = ansi.Truncate(link.Label[:marker], max(0, width-ansi.StringWidth(suffix)), "…") + suffix
			}

			if value, viewErr := link.View(m.theme); viewErr == nil {
				return ansi.Truncate(value, width, "…")
			}
		}
	}

	return ansi.Truncate(row.subject, width, "…")
}

func (m *Model) activityContent() string { return m.activityContentAt(0) }

func (m *Model) activityContentAt(width int) string {
	history := m.agentActivity

	parts := []string{text.Badge("Agent activity", m.theme) + " · newest first · " + m.zoneLabel(), fmt.Sprintf("Page %d · h older · l newer · u latest", history.shownPage+1)}
	if history.err != nil {
		parts = append(parts, feedback.Warn.View(text.Normal, m.theme)+" History incomplete: "+oneLine(safe(history.err.Error()))+" · u retry")
	}

	if history.loading {
		parts = append(parts, "Loading activity page…")
	}

	rows := m.activityRows()
	if len(rows) == 0 && !history.loading && history.err == nil {
		parts = append(parts, "No agent activity recorded yet. Use record-activity --help from an agent session.")
	}

	for _, row := range rows {
		stamp := m.timestamp(row.at, "2006-01-02 15:04:05 -0700")

		subjectWidth := 24
		if width > 0 {
			subjectWidth = max(6, min(24, width/5))
			if width < 100 {
				stamp = m.timestamp(row.at, "01-02 15:04 -0700")
			}

			if width < 70 {
				stamp = m.timestamp(row.at, "15:04:05")
			}
		}

		subject := m.activitySubject(row, subjectWidth)
		subject += strings.Repeat(" ", max(0, subjectWidth-ansi.StringWidth(subject)))
		parts = append(parts, m.muted(stamp)+" │ "+subject+" │ "+row.message)
	}

	if width > 0 {
		for i, line := range parts {
			parts[i] = ansi.Truncate(line, width, "…")
		}
	}

	return strings.Join(parts, "\n")
}

func (m *Model) activityTime(at int64) string {
	return m.muted(m.timestamp(at, briefTimestamp))
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
	m.activitySource()

	if m.activityRender.width != width {
		m.activityRender.rendered = m.activityContentAt(max(1, width))
		m.activityRender.width = width
	}

	return m.activityRender.rendered
}

func (m *Model) moveActivityPage(delta int) tea.Cmd {
	history := &m.agentActivity
	if history.loading || history.err != nil || delta == 0 {
		return nil
	}

	if delta > 0 {
		if !history.hasOlder || history.oldest == 0 {
			return nil
		}

		history.cursors = append(history.cursors[:min(history.page+1, len(history.cursors))], history.oldest)
		history.page++
	} else {
		if history.page == 0 {
			return nil
		}

		history.page--
	}

	m.result.GotoTop()

	if history.page == 0 {
		return m.requestActivity(m.snapshot.GetSequence() + 1)
	}

	return m.requestActivity(history.cursors[history.page])
}
