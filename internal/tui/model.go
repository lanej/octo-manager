// Package tui presents coordinator state using Charmed components.
package tui

import (
	"context"
	"fmt"
	"time"

	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/lanej/charmed/collection"
	"github.com/lanej/charmed/interaction"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
	"github.com/lanej/octo-manager/internal/client"
)

type (
	snapshotMsg struct {
		snapshot *v1.Snapshot
		err      error
	}
	watchMsg struct {
		stream   *connect.ServerStreamForClient[v1.WatchResponse]
		instance string
		err      error
	}
	eventMsg struct {
		stream *connect.ServerStreamForClient[v1.WatchResponse]
		event  *v1.JobEvent
		err    error
	}
	commandMsg      struct{ err error }
	streamClosedMsg struct{ err error }
	tickMsg         struct{}
)

type Model struct {
	ctx             context.Context
	cancel          context.CancelFunc
	api             *client.Client
	snapshot        *v1.Snapshot
	size            layout.Size
	theme           theme.Theme
	focus           interaction.Focus
	result          viewport.Model
	activity        collection.LogViewer
	selected        string
	expanded        bool
	refreshing      bool
	watching        bool
	stream          *connect.ServerStreamForClient[v1.WatchResponse]
	instance        string
	cursor          uint64
	connectionError string
	commandError    string
	commandPending  bool
}

func New(ctx context.Context, api *client.Client, t theme.Theme) *Model {
	session, cancel := context.WithCancel(ctx)
	return &Model{ctx: session, cancel: cancel, api: api, theme: t, focus: interaction.NewFocus("result", "activity"), result: collection.NewViewport("", 1, 1), activity: collection.NewLogViewer(1, 1, t)}
}

func (m *Model) Init() tea.Cmd { return tea.Batch(m.refresh(), tick()) }
func tick() tea.Cmd            { return tea.Tick(time.Second, func(time.Time) tea.Msg { return tickMsg{} }) }

func (m *Model) refresh() tea.Cmd {
	if m.refreshing {
		return nil
	}

	m.refreshing = true

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
		defer cancel()

		response, err := m.api.RPC.GetSnapshot(ctx, connect.NewRequest(&v1.GetSnapshotRequest{}))
		if err != nil {
			return snapshotMsg{err: err}
		}

		return snapshotMsg{snapshot: response.Msg.GetSnapshot()}
	}
}

func (m *Model) watch() tea.Cmd {
	m.watching = true
	instance, cursor := m.instance, m.cursor

	return func() tea.Msg {
		stream, err := m.api.RPC.Watch(m.ctx, connect.NewRequest(&v1.WatchRequest{InstanceId: instance, AfterSequence: cursor}))
		return watchMsg{stream: stream, instance: instance, err: err}
	}
}

func receive(stream *connect.ServerStreamForClient[v1.WatchResponse]) tea.Cmd {
	return func() tea.Msg {
		if stream.Receive() {
			return eventMsg{stream: stream, event: stream.Msg().GetEvent()}
		}

		return eventMsg{stream: stream, err: stream.Err()}
	}
}

func closeStream(stream *connect.ServerStreamForClient[v1.WatchResponse]) tea.Cmd {
	return func() tea.Msg { return streamClosedMsg{err: stream.Close()} }
}

func (m *Model) watchFailed(err error) {
	m.watching = false
	if connect.CodeOf(err) == connect.CodeFailedPrecondition || connect.CodeOf(err) == connect.CodeOutOfRange {
		m.instance = ""
	}

	m.connectionError = "Event stream unavailable; reconnecting"
}

func (m *Model) Update(message tea.Msg) tea.Cmd {
	switch msg := message.(type) {
	case snapshotMsg:
		m.refreshing = false
		if msg.err != nil {
			m.connectionError = "Coordinator unavailable; reconnecting"
			return nil
		}

		if msg.snapshot == nil {
			m.connectionError = "Coordinator returned no snapshot"
			return nil
		}

		var closing tea.Cmd

		if m.instance != msg.snapshot.GetInstanceId() {
			if m.stream != nil {
				closing = closeStream(m.stream)
				m.stream = nil
			}

			m.instance, m.cursor = msg.snapshot.GetInstanceId(), msg.snapshot.GetSequence()
			m.watching = false
		}

		m.snapshot, m.connectionError = msg.snapshot, ""
		m.ensureSelection()
		m.resizeContent()

		if !m.watching {
			return tea.Batch(closing, m.watch())
		}

		return closing
	case watchMsg:
		if msg.instance != m.instance {
			if msg.stream != nil {
				return closeStream(msg.stream)
			}

			return nil
		}

		if msg.err != nil {
			m.watchFailed(msg.err)

			return nil
		}

		m.stream = msg.stream

		return receive(msg.stream)
	case eventMsg:
		if msg.stream != m.stream {
			return nil
		}

		if msg.event == nil {
			m.stream = nil
			m.watchFailed(msg.err)

			return closeStream(msg.stream)
		}

		m.cursor = msg.event.GetSequence()

		return tea.Batch(m.refresh(), receive(msg.stream))
	case tickMsg:
		return tea.Batch(m.refresh(), tick())
	case streamClosedMsg:
		if msg.err != nil && m.ctx.Err() == nil {
			m.connectionError = "Previous event stream could not close cleanly"
		}

		return nil
	case commandMsg:
		m.commandPending = false
		if msg.err != nil {
			m.commandError = fmt.Sprintf("Command failed: %s", safe(msg.err.Error()))
		} else {
			m.commandError = ""
		}

		return m.refresh()
	case tea.KeyPressMsg:
		return m.key(msg)
	}

	return nil
}

func (m *Model) key(key tea.KeyPressMsg) tea.Cmd {
	switch key.String() {
	case "q", "ctrl+c":
		m.cancel()
		return tea.Quit
	case "j", "down":
		m.move(1)
	case "k", "up":
		m.move(-1)
	case "enter":
		m.expanded = !m.expanded
		m.resizeContent()
	case "tab", "shift+tab":
		if m.size.Height >= 18 && m.size.Width >= 32 {
			m.focus.Handle(key)
		}
	case "[", "pgup":
		if m.focus.Current() == "activity" {
			m.activity.ScrollUp(3)
		} else {
			m.result.ScrollUp(3)
		}
	case "]", "pgdown":
		if m.focus.Current() == "activity" {
			m.activity.ScrollDown(3)
		} else {
			m.result.ScrollDown(3)
		}
	case "p", "c", "r":
		return m.control(key.String())
	}

	return nil
}

func (m *Model) control(key string) tea.Cmd {
	if m.snapshot == nil || m.commandPending {
		return nil
	}

	job := m.job()
	if key != "p" && job == nil {
		return nil
	}

	m.commandPending = true
	id := job.GetId()
	paused := m.snapshot.GetScheduler() != v1.SchedulerState_SCHEDULER_STATE_PAUSED

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
		defer cancel()

		var err error

		switch key {
		case "p":
			_, err = m.api.RPC.SetPaused(ctx, connect.NewRequest(&v1.SetPausedRequest{Paused: paused}))
		case "c":
			_, err = m.api.RPC.CancelJob(ctx, connect.NewRequest(&v1.CancelJobRequest{Id: id}))
		case "r":
			_, err = m.api.RPC.RetryJob(ctx, connect.NewRequest(&v1.RetryJobRequest{Id: id}))
		}

		return commandMsg{err: err}
	}
}
func (m *Model) Resize(size layout.Size) { m.size = size; m.resizeContent() }
func (m *Model) ensureSelection() {
	if m.job() == nil && len(m.snapshot.GetJobs()) > 0 {
		m.selected = m.snapshot.GetJobs()[0].GetId()
	}
}

func (m *Model) job() *v1.Job {
	for _, job := range m.snapshot.GetJobs() {
		if job.GetId() == m.selected {
			return job
		}
	}

	return nil
}

func (m *Model) move(delta int) {
	jobs := m.snapshot.GetJobs()
	for i, job := range jobs {
		if job.GetId() == m.selected {
			m.selected = jobs[min(max(0, i+delta), len(jobs)-1)].GetId()
			break
		}
	}

	m.result.GotoTop()
	m.activity.GotoBottom()
	m.resizeContent()
}

func (m *Model) Close() error {
	m.cancel()
	m.api.Close()

	if m.stream != nil {
		return m.stream.Close()
	}

	return nil
}
