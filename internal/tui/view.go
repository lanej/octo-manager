package tui

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"

	"charm.land/log/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/collection"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

type geometry struct {
	body, left, right, result, activity, compact int
	split                                        bool
}

func (m *Model) geometry() geometry {
	body := max(1, m.size.Height-5)
	split := m.size.Width >= 96 && m.size.Height >= 18 && !m.expanded

	left := 0
	if split {
		left = 36
	}

	right := max(1, m.size.Width-left)
	if split {
		right = max(1, right-2)
	}

	compact := 0
	if !split && !m.expanded {
		compact = 2
	}

	activity := 0
	if m.size.Height >= 18 && m.size.Width >= 32 {
		activity = min(8, max(5, body/4))
	}

	result := body - compact
	if activity > 0 {
		result -= activity + 1
	}

	return geometry{body: body, left: left, right: right, result: max(1, result), activity: activity, compact: compact, split: split}
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

func (m *Model) metadata(job *v1.Job, height, width int) []string {
	status := text.Pill(statusLabel(job.GetStatus()), jobTone(job.GetStatus()), m.theme)
	if height < 10 {
		return []string{status}
	}

	duration := ""

	attempts := job.GetAttempts()
	if len(attempts) > 0 && attempts[len(attempts)-1].EndedAtMs != nil {
		a := attempts[len(attempts)-1]
		duration = fmt.Sprintf(" · %.1fs", float64(a.GetEndedAtMs()-a.GetStartedAtMs())/1000)
	}

	item := m.currentSubject()

	heading := item.label
	if heading == "" {
		heading = jobTitle(job)
	}

	rows := []string{m.theme.Heading().Render(heading)}
	if item.url != "" {
		rows = append(rows, strings.Split(ansi.Hardwrap(item.url, max(1, width), false), "\n")...)
	}

	run := 1

	for i, candidate := range item.jobs {
		if candidate.GetId() == job.GetId() {
			run = i + 1
		}
	}

	rows = append(rows, jobTitle(job)+fmt.Sprintf(" · run %d/%d", run, max(1, len(item.jobs))), status+fmt.Sprintf("  Attempt %d%s", len(attempts), duration), "")

	return rows
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
	var events []*v1.JobEvent

	for _, event := range m.snapshot.GetRecentEvents() {
		if event.GetJobId() == m.selected || event.GetJobId() == "" {
			events = append(events, event)
		}
	}

	return events
}

func (m *Model) resizeContent() {
	g := m.geometry()
	if g.activity == 0 {
		m.focus.Set("result")
	}

	inner := layout.PanelContentSize(layout.Size{Width: g.right, Height: g.result})
	content := "Submit a job from another terminal with `bin/octo-manager demo`."
	metadata := 0

	if job := m.job(); job != nil {
		content = markdown(job, m.events())
		metadata = len(m.metadata(job, g.result, inner.Width))
	}

	rendered, err := text.Markdown(content, max(1, inner.Width), m.theme)
	if err != nil {
		rendered = safe(content)
	}

	m.result.SetWidth(max(1, inner.Width))
	m.result.SetHeight(max(1, inner.Height-metadata))
	m.result.SetContent(rendered)
	oldOffset, follow := m.activity.YOffset(), m.activity.AtBottom()
	logSize := layout.PanelContentSize(layout.Size{Width: g.right, Height: g.activity})

	m.activity = collection.NewLogViewer(max(1, logSize.Width), max(1, logSize.Height), m.theme)
	for _, event := range m.events() {
		if event.GetKind() == "worker_started" || (event.GetKind() == "progress" && !strings.HasPrefix(event.GetDetail(), "Using existing ")) {
			continue
		}

		message := strings.ReplaceAll(event.GetKind(), "_", " ")
		if event.GetKind() == "tool" || event.GetKind() == "progress" {
			message = strings.ReplaceAll(safe(event.GetDetail()), "_", " ")
		}

		level := log.InfoLevel
		if event.GetKind() == "failed" {
			level = log.ErrorLevel
		}

		if event.GetKind() == "conflicted" {
			level = log.WarnLevel
			message = "Merge conflict detected"
		}

		m.activity.Append(collection.LogEntry{Time: time.UnixMilli(event.GetAtMs()).UTC(), Level: level, Message: message})
	}

	if follow {
		m.activity.GotoBottom()
	} else {
		m.activity.SetYOffset(oldOffset)
	}
}

func (m *Model) queue(g geometry) string {
	capacity := max(1, (g.body-2)/4)
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

		job := item.jobs[len(item.jobs)-1]
		if item.key == current {
			prefix = "› "
			heading = m.theme.Heading().Render(heading)
			job = m.job()
		}

		rows = append(rows, prefix+heading, "  "+jobTitle(job)+" · "+counted(len(item.jobs), "run"), "  "+text.Pill(statusLabel(job.GetStatus()), jobTone(job.GetStatus()), m.theme), "")
	}

	if len(items) == 0 {
		rows = []string{"No pull requests yet.", "", "Submit a public PR URL", "with the CLI."}
	}

	return layout.Panel("PULL REQUESTS / DEMOS", strings.Join(rows, "\n"), layout.Size{Width: g.left, Height: g.body}, m.theme, false)
}

func counted(count int, noun string) string {
	if count != 1 {
		noun += "s"
	}

	return fmt.Sprintf("%d %s", count, noun)
}
func shortID(value string) string { return string([]rune(value)[:min(8, len([]rune(value)))]) }
func (m *Model) View() string {
	connected := "connected"
	if m.snapshot == nil || m.connectionError != "" {
		connected = "reconnecting"
	}

	heading := m.theme.Heading().Render("OCTO MANAGER") + "  " + m.theme.Subtle().Render(connected)

	prCount := 0

	for _, item := range m.subjects() {
		if item.url != "" {
			prCount++
		}
	}

	detail := fmt.Sprintf("%s · %s · %s · worker %s", counted(prCount, "PR"), counted(len(m.snapshot.GetJobs()), "run"), strings.ToLower(strings.TrimPrefix(m.snapshot.GetScheduler().String(), "SCHEDULER_STATE_")), strings.ToLower(strings.TrimPrefix(m.snapshot.GetWorker().String(), "WORKER_STATE_")))
	if m.snapshot.GetRecoveryPid() != 0 {
		detail = fmt.Sprintf("Waiting for previous worker PID %d", m.snapshot.GetRecoveryPid())
	}

	if m.connectionError != "" {
		detail = m.connectionError
	}

	if m.commandError != "" {
		detail = m.commandError
	}

	header := []string{heading, m.theme.Subtle().Render(detail), ""}
	if m.size.Width < 32 || m.size.Height < 12 {
		if job := m.job(); job != nil {
			header = append(header, jobTitle(job), statusLabel(job.GetStatus()))
		}

		header = header[:min(len(header), max(0, m.size.Height-1))]
		for len(header) < m.size.Height-1 {
			header = append(header, "")
		}

		return layout.Fit(strings.Join(append(header, "q quit · j/k PRs"), "\n"), m.size)
	}

	g := m.geometry()

	content := m.result.View()
	if job := m.job(); job != nil {
		content = strings.Join(m.metadata(job, g.result, layout.PanelContentSize(layout.Size{Width: g.right, Height: g.result}).Width), "\n") + "\n" + content
	}

	resultTitle := "RESULT"
	if m.result.TotalLineCount() > m.result.Height() {
		resultTitle = fmt.Sprintf("RESULT · %.0f%%", m.result.ScrollPercent()*100)
	}

	right := layout.Panel(resultTitle, content, layout.Size{Width: g.right, Height: g.result}, m.theme, m.focus.Current() == "result")
	if g.activity > 0 {
		right += "\n\n" + layout.Panel("ACTIVITY · UTC", m.activity.View(), layout.Size{Width: g.right, Height: g.activity}, m.theme, m.focus.Current() == "activity")
	}

	if g.compact > 0 {
		label := "No jobs yet"
		if job := m.job(); job != nil {
			label = m.currentSubject().label + " · " + statusLabel(job.GetStatus())
		}

		right = m.theme.Subtle().Render("PR · "+label) + "\n\n" + right
	}

	body := right
	if g.split {
		body = layout.Row(m.queue(g), strings.Repeat(" ", 2), right)
	}

	help := "j/k PRs · h/l runs · o open · tab pane · [/] scroll · p pause · c cancel · r retry · q quit"
	if m.size.Width < 96 {
		help = "q quit · j/k PRs · h/l runs · o open · [/] scroll · enter expand"
	}

	footer := []string{m.theme.Subtle().Render(help), ""}
	if job := m.job(); job != nil {
		identity := m.currentSubject().url
		if identity == "" {
			identity = "Local demo · " + shortID(job.GetId())
		}

		footer[1] = m.theme.Subtle().Render(identity)
	}

	return layout.Fit(strings.Join(header, "\n")+"\n"+body+"\n"+strings.Join(footer, "\n"), m.size)
}
