package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

type panelView uint8

const (
	reviewsPanel panelView = iota
	outputPanel
	statePanel
	trackingPanel
	activityPanel
	githubPanel
)

type (
	reviewMsg struct {
		url     string
		details *v1.PullRequestDetails
		err     error
		status  *v1.RefreshStatus
	}
	historyMsg struct {
		job, instance   string
		version, target uint64
		events          []*v1.JobEvent
		err             error
	}
	historyState struct {
		job, instance                string
		version, cursor, seenThrough uint64
		loading                      bool
		events                       []*v1.JobEvent
		err                          error
	}
)

func (m *Model) loadReviews(force bool) tea.Cmd {
	address := m.currentSubject().url
	if m.panel != reviewsPanel || address == "" || m.reviewLoading[address] || (!force && (m.reviews[address] != nil || m.reviewErrors[address] != "")) {
		return nil
	}

	m.reviewLoading[address] = true
	m.reviewErrors[address] = ""
	m.resizeContent()

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
		defer cancel()

		response, err := m.api.RPC.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{Url: address, Refresh: force}))
		if err != nil {
			return reviewMsg{url: address, err: err}
		}

		return reviewMsg{url: address, details: response.Msg.GetPullRequest(), status: response.Msg.GetRefresh()}
	}
}

func (m *Model) loadHistory() tea.Cmd {
	if m.job() == nil || m.instance == "" {
		return nil
	}

	if m.history.job != m.selected || m.history.instance != m.instance || m.history.cursor > m.snapshot.GetSequence() || m.history.seenThrough > m.snapshot.GetSequence() {
		m.history = historyState{job: m.selected, instance: m.instance, version: m.history.version + 1}
	}

	if m.history.loading || (m.history.seenThrough >= m.snapshot.GetSequence() && m.history.err == nil) {
		return nil
	}

	m.history.loading = true
	m.resizeContent()
	job, instance, version, cursor, target := m.history.job, m.history.instance, m.history.version, m.history.cursor, m.snapshot.GetSequence()

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
		defer cancel()

		response, err := m.api.RPC.ListEvents(ctx, connect.NewRequest(&v1.ListEventsRequest{JobId: new(job), AfterSequence: cursor}))
		if err != nil {
			return historyMsg{job: job, instance: instance, version: version, target: target, err: err}
		}

		return historyMsg{job: job, instance: instance, version: version, target: target, events: response.Msg.GetEvents()}
	}
}

func (m *Model) applyReview(msg reviewMsg) tea.Cmd {
	m.reviewLoading[msg.url] = false
	if msg.err != nil {
		m.reviewErrors[msg.url] = safe(msg.err.Error())
	} else if msg.details == nil {
		m.reviewErrors[msg.url] = ""
	} else {
		m.reviews[msg.url] = msg.details
		m.reviewErrors[msg.url] = ""
	}

	if msg.status != nil {
		m.reviewStatuses[msg.url] = msg.status
		m.reviewLoading[msg.url] = msg.status.GetState() == v1.RefreshState_REFRESH_STATE_QUEUED || msg.status.GetState() == v1.RefreshState_REFRESH_STATE_RUNNING
		m.reviewErrors[msg.url] = safe(msg.status.GetLastError())
	}

	if m.currentSubject().url == msg.url {
		m.resizeContent()
	}

	return nil
}

func (m *Model) applyHistory(msg historyMsg) tea.Cmd {
	if msg.job != m.selected || msg.instance != m.instance || msg.version != m.history.version {
		return nil
	}

	m.history.loading = false

	m.history.err = msg.err
	if msg.err != nil {
		m.resizeContent()
		return nil
	}

	for _, event := range msg.events {
		if event.GetJobId() != m.selected || event.GetSequence() <= m.history.cursor {
			continue
		}

		m.history.events = append(m.history.events, event)
		m.history.cursor = event.GetSequence()
	}

	if len(msg.events) < 200 {
		m.history.seenThrough = msg.target
	}

	m.resizeContent()

	if len(msg.events) == 200 {
		return m.loadHistory()
	}

	return nil
}

func (m *Model) reviewsMarkdown() string {
	address := m.currentSubject().url
	if address == "" {
		return "This local fixture has no GitHub review messages. Use **2** for worker output or **3** for its state and transition history."
	}

	details := m.reviews[address]

	notice := ""
	if m.reviewLoading[address] {
		notice = "Refresh pending; showing the latest stored review state.\n\n"
		if status := m.reviewStatuses[address]; status.GetState() == v1.RefreshState_REFRESH_STATE_QUEUED {
			notice = "Refresh queued; showing the latest stored review state.\n\n"
		} else if status.GetState() == v1.RefreshState_REFRESH_STATE_RUNNING {
			notice = "Refreshing; showing the latest stored review state.\n\n"
		}
	}

	if m.reviewErrors[address] != "" {
		notice = "**Reviews unavailable**\n\n" + m.reviewErrors[address] + "\n\nPress **u** to retry.\n\n"
	}

	if details == nil {
		if notice == "" {
			return "No cached review feedback. Press **u** to load reviews for this PR."
		}

		return notice
	}

	if status := m.reviewStatuses[address]; status != nil && status.GetDueAtMs() != 0 {
		notice += "Next eligible refresh: " + m.timestamp(status.GetDueAtMs(), fullTimestamp) + "\n\n"
	}

	result := notice + "# " + safe(details.GetTitle()) + "\n\n" + safe(details.GetState()) + " · observed " + m.timestamp(details.GetObservedAtMs(), fullTimestamp) + " · head `" + shortSHA(details.GetHeadSha()) + "`\n\n"
	if details.GetMayHaveMoreMessages() {
		result += "**Partial history:** first 100 items per message source. More may exist on GitHub.\n\n"
	}

	if len(details.GetMessages()) == 0 {
		return result + "No review or discussion messages returned by GitHub. Press **u** to refresh."
	}

	for _, message := range details.GetMessages() {
		label := strings.ReplaceAll(safe(message.GetKind()), "_", " ")
		if message.GetKind() == "review_comment" {
			label = "inline review"
		}

		if message.GetState() != "" {
			label = strings.ToLower(strings.ReplaceAll(safe(message.GetState()), "_", " "))
		}

		result += "**@" + safe(message.GetAuthor()) + " · " + label + "**"
		if message.GetAtMs() != 0 {
			result += " · " + m.timestamp(message.GetAtMs(), "2006-01-02 15:04 MST -0700")
		}

		result += "\n\n"

		var context []string

		if message.GetPath() != "" {
			location := "`" + safe(message.GetPath()) + "`"
			if message.GetLine() != 0 {
				location += fmt.Sprintf(":%d", message.GetLine())
			}

			context = append(context, location)
		}

		if message.GetCommitSha() != "" && message.GetCommitSha() != details.GetHeadSha() {
			context = append(context, "earlier commit `"+shortSHA(message.GetCommitSha())+"`")
		}

		if len(context) > 0 {
			result += strings.Join(context, " · ") + "\n\n"
		}

		if message.GetBodyMarkdown() != "" {
			result += safe(message.GetBodyMarkdown()) + "\n\n"
		}

		if message.GetBodyTruncated() {
			result += "Message truncated; open its link for the full text.\n\n"
		}

		result += safe(message.GetUrl()) + "\n\n---\n\n"
	}

	return result
}

func shortSHA(value string) string {
	value = safe(value)
	return value[:min(8, len(value))]
}
