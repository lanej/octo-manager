package tui

import (
	tea "charm.land/bubbletea/v2"
	"github.com/lanej/charmed/theme"
)

// FollowTerminalTheme uses terminal-reported surfaces and Charmed's semantic palette.
func (m *Model) FollowTerminalTheme() {
	m.terminalTheme = true
}

func (m *Model) terminalBackground(msg tea.BackgroundColorMsg) {
	if !m.terminalTheme || msg.Color == nil {
		return
	}

	mode := theme.Dark
	if !msg.IsDark() {
		mode = theme.Light
	}

	t := theme.New(mode)

	t.Background, t.Surface = msg.Color, msg.Color
	if m.terminalForeground != nil {
		t.Foreground = m.terminalForeground
	}

	t.SelectionForeground = t.Foreground
	m.theme = t
	m.activityRender.valid = false
	m.resizeContent()
}
