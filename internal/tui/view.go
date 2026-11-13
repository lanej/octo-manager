package tui

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"

	"charm.land/log/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/collection"
	"github.com/lanej/charmed/feedback"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/navigation"
	"github.com/lanej/charmed/text"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

type geometry struct {
	body, left, right, result, activity int
	split                               bool
}

func (m *Model) geometry() geometry {
	body := max(1, m.size.Height-len(m.header())-2)
	split := m.size.Width >= 96 && m.size.Height >= 18 && !m.expanded && !m.globalPanel()

	left := 0
	if split {
		left = 36
	}

	right := max(1, m.size.Width-left)
	if split {
		right = max(1, right-2)
	}

	activity := 0
	if m.size.Height >= 18 && m.size.Width >= 32 && !m.globalPanel() {
		activity = min(8, max(5, body/4))
	}

	result := body - 1
	if activity > 0 {
		result -= activity + 1
	}

	return geometry{body: body, left: left, right: right, result: max(1, result), activity: activity, split: split}
}

func safe(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}

		return r
	}, ansi.Strip(value))
}

func jobTitle(job *v1.Job) string {
	switch job.GetTask().GetKind().(type) {
	case *v1.Task_ResolveConflict:
		return "Conflict demo"
	case *v1.Task_SummarizePullRequest:
		return "Summarize PR"
	default:
		return "Unknown task"
	}
}

func statusLabel(status v1.JobStatus) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimPrefix(status.String(), "JOB_STATUS_"), "_", " "))
}

func jobTone(status v1.JobStatus) text.Tone {
	switch status {
	case v1.JobStatus_JOB_STATUS_SUCCEEDED:
		return text.Success
	case v1.JobStatus_JOB_STATUS_FAILED:
		return text.Danger
	case v1.JobStatus_JOB_STATUS_CONFLICTED, v1.JobStatus_JOB_STATUS_RETRY_WAIT:
		return text.Warning
	case v1.JobStatus_JOB_STATUS_RUNNING, v1.JobStatus_JOB_STATUS_RESOLVING, v1.JobStatus_JOB_STATUS_CANCELLING:
		return text.Info
	case v1.JobStatus_JOB_STATUS_UNSPECIFIED, v1.JobStatus_JOB_STATUS_QUEUED, v1.JobStatus_JOB_STATUS_CANCELLED, v1.JobStatus_JOB_STATUS_INTERRUPTED:
		return text.Neutral
	default:
		return text.Neutral
	}
}

func markdown(job *v1.Job, events []*v1.JobEvent) string {
	if job.GetResultMarkdown() != "" {
		raw := safe(job.GetResultMarkdown())

		index := strings.LastIndex(raw, "\n\n")
		if job.GetStatus() == v1.JobStatus_JOB_STATUS_SUCCEEDED && job.GetTask().GetResolveConflict() != nil && index >= 0 {
			var receipt struct {
				Clean  bool   `json:"clean"`
				Commit string `json:"mergeCommit"`
				Policy struct {
					Attempts int `json:"maxAttempts"`
					Timeout  int `json:"timeoutSeconds"`
					Delay    int `json:"retryDelaySeconds"`
				} `json:"policy"`
			}
			if err := json.Unmarshal([]byte(raw[index+2:]), &receipt); err == nil && receipt.Clean {
				hash, hashErr := hex.DecodeString(receipt.Commit)

				policy, policyErr := json.MarshalIndent(receipt.Policy, "", "  ")
				if hashErr == nil && len(hash) == 20 && policyErr == nil {
					return raw[:index] + "\n\n---\n\n**Independently verified** · clean two-parent merge\n\n```json\n" + string(policy) + "\n```\n\nCommit `" + receipt.Commit + "`"
				}
			}
		}

		return raw
	}

	if job.GetError() != "" {
		return "**" + statusLabel(job.GetStatus()) + "**\n\n" + safe(job.GetError())
	}

	var (
		progress     []string
		attemptStart int64
	)
	if attempts := job.GetAttempts(); len(attempts) > 0 {
		attemptStart = attempts[len(attempts)-1].GetStartedAtMs()
	}

	for _, event := range events {
		if event.GetAtMs() >= attemptStart && event.GetKind() == "progress" && !strings.HasPrefix(event.GetDetail(), "Using existing ") {
			progress = append(progress, safe(event.GetDetail()))
		}
	}

	if len(progress) > 0 {
		return strings.Join(progress, "")
	}

	for i := len(events) - 1; i >= 0; i-- {
		if events[i].GetAtMs() >= attemptStart && events[i].GetKind() == "conflicted" {
			return "**Reconciling the two branches**\n\n```diff\n" + safe(events[i].GetDetail()) + "\n```"
		}
	}

	return "Waiting for worker output…"
}

func (m *Model) events() []*v1.JobEvent {
	bySequence := map[uint64]*v1.JobEvent{}

	if m.history.job == m.selected && m.history.instance == m.instance {
		for _, event := range m.history.events {
			bySequence[event.GetSequence()] = event
		}
	}

	for _, event := range m.snapshot.GetRecentEvents() {
		if event.GetPrId() == "" && (event.GetJobId() == m.selected || event.GetJobId() == "") {
			bySequence[event.GetSequence()] = event
		}
	}

	events := make([]*v1.JobEvent, 0, len(bySequence))
	for _, event := range bySequence {
		events = append(events, event)
	}

	sort.Slice(events, func(i, j int) bool { return events[i].GetSequence() < events[j].GetSequence() })

	return events
}

func (m *Model) resizeContent() {
	if m.panel != trackingPanel {
		m.checkWatchPR = ""
	}

	g := m.geometry()
	if g.activity == 0 {
		m.focus.Set("result")
	}

	inner := layout.PanelContentSize(layout.Size{Width: g.right, Height: g.result})
	inner.Width = max(1, inner.Width-1)
	content := "Track or submit a PR URL from another terminal."

	if job := m.job(); job != nil {
		switch m.panel {
		case reviewsPanel:
			content = m.reviewsMarkdown()
		case outputPanel:
			content = markdown(job, m.events())
		case statePanel:
			content = m.stateView(inner.Width)
		case trackingPanel:
			content = m.trackingContent()
		case activityPanel:
			content = m.activitySource()
		case githubPanel:
			content = m.githubContent(inner.Width)
		default:
			content = "Unknown view"
		}
	}

	if m.panel == trackingPanel {
		content = m.trackingContent()
	} else if m.job() == nil {
		if m.panel == reviewsPanel && m.currentSubject().url != "" {
			content = m.reviewsMarkdown()
		} else if m.currentSubject().tracked != nil {
			content = "No worker runs. Use **4 Tracking** for ownership and pending actions."
		}
	}

	switch m.panel {
	case activityPanel:
		content = m.activitySource()
	case githubPanel:
		content = m.githubContent(inner.Width)
	case reviewsPanel, outputPanel, statePanel, trackingPanel:
	default:
		content = "Unknown view"
	}

	rendered := content
	if m.panel == activityPanel {
		rendered = m.renderedActivity(max(1, inner.Width))
	} else if m.panel == trackingPanel || m.panel == githubPanel {
		rendered = m.renderedContent(content, inner.Width, false)
	} else if m.panel != statePanel {
		rendered = m.renderedContent(content, inner.Width, true)
	}

	m.result.SetWidth(max(1, inner.Width))
	m.result.SetHeight(max(1, inner.Height))
	m.result.SetContent(rendered)

	if m.globalPanel() {
		return
	}

	oldOffset, follow := m.activity.YOffset(), m.activity.AtBottom()

	logSize := layout.PanelContentSize(layout.Size{Width: g.right, Height: g.activity})

	if m.panel == trackingPanel {
		prID := m.currentSubject().tracked.GetId()
		if m.checkWatchPR != prID {
			oldOffset = 0
		}

		m.checkWatchPR = prID
		m.activity.SetWidth(max(1, logSize.Width-1))
		m.activity.SetHeight(max(1, logSize.Height))
		m.activity.SetContent(ansi.Wrap(m.checkWatchContent(m.currentSubject().tracked), max(1, logSize.Width-1), " "))
		m.activity.SetYOffset(oldOffset)

		return
	}

	m.activity = collection.NewLogViewer(max(1, logSize.Width), max(1, logSize.Height-len(m.workerLines())), m.theme)
	for _, event := range m.events() {
		if event.GetKind() != "tool" {
			continue
		}

		m.activity.Append(collection.LogEntry{Time: m.displayTime(event.GetAtMs()), Level: log.InfoLevel, Message: m.timestamp(event.GetAtMs(), "MST -0700") + " · " + strings.ReplaceAll(safe(event.GetDetail()), "_", " ")})
	}

	if follow {
		m.activity.GotoBottom()
	} else {
		m.activity.SetYOffset(oldOffset)
	}
}

func (m *Model) queue(g geometry) string {
	capacity := max(1, (g.body-2)/3)
	items := m.subjects()
	current := m.currentSubject().key
	index := 0

	for i, item := range items {
		if item.key == current {
			index = i
			break
		}
	}

	start := max(0, index-capacity+1)
	rows := []string{}

	for _, item := range items[start:min(start+capacity, len(items))] {
		prefix := "  "
		heading := item.label

		available := max(1, layout.PanelContentSize(layout.Size{Width: g.left, Height: g.body}).Width-2)
		if marker := strings.LastIndex(heading, "#"); marker >= 0 && ansi.StringWidth(heading) > available {
			suffix := heading[marker:]
			heading = ansi.Truncate(heading[:marker], max(0, available-ansi.StringWidth(suffix)), "…") + suffix
		}

		if item.key == current {
			prefix = "› "
			heading = m.theme.Heading().Render(heading)
		}

		summary := counted(len(item.jobs), "run")
		if item.tracked != nil {
			summary += " · " + counted(m.openActions(item.tracked.GetId()), "action")
		}

		rows = append(rows, prefix+heading, "  "+summary, "")
	}

	if len(items) == 0 {
		rows = []string{"No pull requests yet.", "", "Track or submit a PR URL", "with the CLI."}
	}

	title := "PULL REQUESTS"

	for _, item := range items {
		if item.url == "" {
			title = "PULL REQUESTS / JOBS"

			break
		}
	}

<<<<<<< HEAD
	return layout.Panel(title, strings.Join(rows, "\n"), layout.Size{Width: g.left, Height: g.body}, m.theme, false)
||||||| parent of 281a265 (fix(tui): compact tracking and activity)
	return layout.Panel("PULL REQUESTS / DEMOS", strings.Join(rows, "\n"), layout.Size{Width: g.left, Height: g.body}, m.theme, false)
=======
	return layout.Panel("PULL REQUESTS", strings.Join(rows, "\n"), layout.Size{Width: g.left, Height: g.body}, m.theme, false)
>>>>>>> 281a265 (fix(tui): compact tracking and activity)
}

func counted(count int, noun string) string {
	if count != 1 {
		noun += "s"
	}

	return fmt.Sprintf("%d %s", count, noun)
}

func (m *Model) header() []string {
	connection := feedback.Connected
	if m.snapshot == nil || m.connectionError != "" {
		connection = feedback.Disconnected
	}

	identity := m.currentSubject().label
	if m.currentSubject().url != "" {
		identity = m.link(m.currentSubject().url)
	}

	if identity == "" {
		identity = "Track or submit a PR URL"
	}

	switch m.panel {
	case activityPanel:
		identity = "All agent sessions"
	case githubPanel:
		identity = "GitHub traffic and rate limits"
	case reviewsPanel, outputPanel, statePanel, trackingPanel:
	default:
		identity = "Unknown view"
	}

	context := strings.Split(ansi.Hardwrap(identity, max(1, m.size.Width), false), "\n")
	chrome := layout.Header{Title: "OCTO MANAGER", Context: context[0], Actions: connection.View(text.Normal, m.theme)}
	lines := strings.Split(chrome.View(m.size.Width, m.theme), "\n")
	lines = append(lines, context[1:]...)

	return append(lines, "")
}

func (m *Model) View() string {
	header := m.header()
	if m.size.Width < 32 || m.size.Height < 12 {
		header = header[:min(len(header), max(0, m.size.Height-1))]
		for len(header) < m.size.Height-1 {
			header = append(header, "")
		}

		return layout.Fit(strings.Join(append(header, "q quit · j/k PRs"), "\n"), m.size)
	}

	g := m.geometry()

	tabs := navigation.NewTabs([]navigation.Tab{{ID: "reviews", Label: "1 Reviews"}, {ID: "output", Label: "2 Output"}, {ID: "state", Label: "3 State"}, {ID: "tracking", Label: "4 Tracking"}, {ID: "agent-activity", Label: "5 Activity"}, {ID: "github", Label: "6 GitHub"}}, m.theme)
	tabs.Select(m.panelID())
	tabs.SetWidth(g.right)

	scrollbar := feedback.Scrollbar{Total: m.result.TotalLineCount(), Visible: m.result.Height(), Offset: m.result.YOffset(), Height: m.result.Height()}
	content := layout.Row(m.result.View(), scrollbar.View(m.theme))

	right := tabs.View() + "\n" + layout.Panel("", content, layout.Size{Width: g.right, Height: g.result}, m.theme, m.focus.Current() == "result")
	if g.activity > 0 {
		if m.panel == trackingPanel {
			right += "\n\n" + layout.Panel("CHECK WATCHES", layout.Row(m.activity.View(), (feedback.Scrollbar{Total: m.activity.TotalLineCount(), Visible: m.activity.Height(), Offset: m.activity.YOffset(), Height: m.activity.Height()}).View(m.theme)), layout.Size{Width: g.right, Height: g.activity}, m.theme, m.focus.Current() == "activity")
		} else {
			lines := m.workerLines()
			logSize := layout.PanelContentSize(layout.Size{Width: g.right, Height: g.activity})

			worker := strings.Join(lines, "\n")
			if logSize.Height > len(lines) {
				worker += "\n" + m.activity.View()
			}

			right += "\n\n" + layout.Panel("WORKER · recent tools · "+m.zoneLabel(), worker, layout.Size{Width: g.right, Height: g.activity}, m.theme, m.focus.Current() == "activity")
		}
	}

	body := right
	if g.split {
		body = layout.Row(m.queue(g), strings.Repeat(" ", 2), right)
	}

	help := "u refresh · o browser · [/] scroll · tab pane · q quit"
	if m.size.Width < 96 {
		help = "o browser · [/] scroll · q quit"
	}

	notice := "j/k PRs · h/l runs · enter expand · p pause · c cancel run · r retry run"

	switch m.panel {
	case activityPanel:
		help = "[/] scroll · q quit"
		notice = "h/l older/newer · j/k scroll · u refresh"
	case githubPanel:
		help = "[/] scroll · q quit"
		notice = "j/k scroll · u refresh local metrics"
	case reviewsPanel, outputPanel, statePanel, trackingPanel:
	default:
		notice = "Unknown view · q quit"
	}

	if m.connectionError != "" {
		notice = m.connectionError
	}

	if m.commandError != "" {
		notice = m.commandError
	}

	dispatch := strings.ToLower(strings.TrimPrefix(m.snapshot.GetScheduler().String(), "SCHEDULER_STATE_"))

	status := "dispatch " + dispatch
	if m.size.Width >= 96 && m.panel != githubPanel {
		status += " · " + m.githubSummary()
	}

	footer := layout.Footer{Help: help, Status: status}

	return layout.Fit(strings.Join(header, "\n")+"\n"+body+"\n"+footer.View(m.size.Width, m.theme)+"\n"+m.theme.Subtle().Render(notice), m.size)
}

func (m *Model) renderMarkdown(content string, width int) string {
 rendered, err := m.markdownText(content, width)
 if err != nil { return safe(content) }
 return rendered
}

func (m *Model) markdownText(content string, width int) (string, error) {
 style := text.MarkdownStyles(m.theme)
 style.H1.Prefix, style.H2.Prefix, style.H3.Prefix, style.H4.Prefix, style.H5.Prefix, style.H6.Prefix = "", "", "", "", "", ""
 if m.theme.Mode == theme.Mono {
  style.Strong.BlockPrefix, style.Strong.BlockSuffix = "", ""
  style.Emph.BlockPrefix, style.Emph.BlockSuffix = "", ""
 }
 return text.Markdown(safe(content), max(1, width), m.theme, text.MarkdownOptions{Styles: &style})
}
