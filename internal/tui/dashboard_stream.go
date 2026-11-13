package tui

import (
	"context"
	"strconv"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

type dashboardOpened struct {
	version uint64
	stream  *connect.ServerStreamForClient[v1.WatchDashboardResponse]
	err     error
}
type dashboardFrame struct {
	version uint64
	stream  *connect.ServerStreamForClient[v1.WatchDashboardResponse]
	frame   *v1.WatchDashboardResponse
	err     error
}

func (m *Model) syncDashboard() tea.Cmd {
	if !m.dashboardStarted {
		return nil
	}

	address := m.currentSubject().url
	reviews := m.panel == reviewsPanel

	key := address + ":" + strconv.FormatBool(reviews)
	if m.watching && m.dashboardKey == key {
		return nil
	}

	if m.dashboardCancel != nil {
		m.dashboardCancel()
	}

	m.dashboardVersion++
	version := m.dashboardVersion
	m.dashboardKey, m.watching = key, true
	m.selectedRefresh = nil
	ctx, cancel := context.WithCancel(m.ctx)
	m.dashboardCancel = cancel

	return func() tea.Msg {
		stream, err := m.api.RPC.WatchDashboard(ctx, connect.NewRequest(&v1.WatchDashboardRequest{Url: address, Reviews: reviews}))
		return dashboardOpened{version: version, stream: stream, err: err}
	}
}

func dashboardReceive(stream *connect.ServerStreamForClient[v1.WatchDashboardResponse], version uint64) tea.Cmd {
	return func() tea.Msg {
		if stream.Receive() {
			return dashboardFrame{version: version, stream: stream, frame: stream.Msg()}
		}

		return dashboardFrame{version: version, stream: stream, err: stream.Err()}
	}
}

func closeDashboard(stream *connect.ServerStreamForClient[v1.WatchDashboardResponse]) tea.Cmd {
	return func() tea.Msg { return streamClosedMsg{err: stream.Close()} }
}

func (m *Model) applyDashboard(msg dashboardFrame) tea.Cmd {
	if msg.version != m.dashboardVersion {
		if msg.stream == nil {
			return nil
		}

		return closeDashboard(msg.stream)
	}

	if msg.frame == nil {
		m.watching = false
		m.connectionError = "Dashboard stream unavailable; reconnecting"

		return closeDashboard(msg.stream)
	}

	commands := []tea.Cmd{m.Update(snapshotMsg{snapshot: msg.frame.GetSnapshot()})}
	if msg.version != m.dashboardVersion {
		if msg.stream != nil {
			commands = append(commands, closeDashboard(msg.stream))
		}

		return tea.Batch(commands...)
	}

	m.selectedRefresh = msg.frame.GetRefresh()

	address := m.currentSubject().url
	if m.panel == reviewsPanel && address != "" {
		if details := msg.frame.GetPullRequest(); details != nil && details.GetUrl() == address {
			m.reviews[address] = details
		}

		status := msg.frame.GetRefresh()
		m.reviewStatuses[address] = status
		m.reviewErrors[address] = safe(status.GetLastError())
		m.reviewLoading[address] = status.GetState() == v1.RefreshState_REFRESH_STATE_QUEUED || status.GetState() == v1.RefreshState_REFRESH_STATE_RUNNING
	}

	m.resizeContent()

	return tea.Batch(append(commands, dashboardReceive(msg.stream, msg.version))...)
}
