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
)

type (
	reviewMsg struct {
		url     string
		details *v1.PullRequestDetails
		err     error
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

		response, err := m.api.RPC.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{Url: address}))
		if err != nil {
			return reviewMsg{url: address, err: err}
		}

		return reviewMsg{url: address, details: response.Msg.GetPullRequest()}
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
		m.reviewErrors[msg.url] = "Coordinator returned no PR details"
	} else {
		m.reviews[msg.url] = msg.details
		m.reviewErrors[msg.url] = ""
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

func (m *Model) panelTitle() string {
	switch m.panel {
	case reviewsPanel:
		return "REVIEWS · 1"
	case outputPanel:
		return "WORKER OUTPUT · 2"
	case statePanel:
		return "STATE & TRANSITIONS · 3"
	default:
		return "UNKNOWN VIEW"
	}
}

func (m *Model) reviewsMarkdown() string {
	address := m.currentSubject().url
	if address == "" {
		return "This local fixture has no GitHub review messages. Use **2** for worker output or **3** for its state and transition history."
	}

	details := m.reviews[address]

	notice := ""
	if m.reviewLoading[address] {
		notice = "Refreshing GitHub reviews…\n\n"
	}

	if m.reviewErrors[address] != "" {
		notice = "**Reviews unavailable**\n\n" + m.reviewErrors[address] + "\n\nPress **u** to retry.\n\n"
	}

	if details == nil {
		return notice
	}

	result := notice + "# " + safe(details.GetTitle()) + "\n\n" + safe(details.GetState()) + " · observed " + time.UnixMilli(details.GetObservedAtMs()).UTC().Format("2006-01-02 15:04:05 UTC") + " · head `" + shortSHA(details.GetHeadSha()) + "`\n\n"
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
			result += " · " + time.UnixMilli(message.GetAtMs()).UTC().Format("2006-01-02 15:04 UTC")
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
