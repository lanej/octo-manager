package tui

import (
	"context"
	"image/color"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	"github.com/lanej/octo-manager/internal/client"
)

func TestCachedContentStillUpdatesWithoutSequenceChange(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.Resize(layout.Size{Width: 132, Height: 40})
	m.Update(snapshotMsg{snapshot: m.snapshot})

	m.snapshot.Jobs[0].ResultMarkdown = new("Fresh result arrived without an event revision.")
	m.Update(snapshotMsg{snapshot: m.snapshot})

	view := ansi.Strip(m.View())
	if !strings.Contains(view, "Fresh result arrived") || strings.Contains(view, "Combined policy") {
		t.Fatal("render cache concealed new snapshot content")
	}

	m.Resize(layout.Size{Width: 40, Height: 16})

	for _, line := range strings.Split(m.View(), "\n") {
		if ansi.StringWidth(line) > 40 {
			t.Fatal("cached content ignored the new viewport width")
		}
	}
}

func TestCachedMarkdownFollowsTerminalForeground(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.FollowTerminalTheme()
	m.Resize(layout.Size{Width: 132, Height: 40})

	before := m.result.View()
	m.Update(tea.ForegroundColorMsg{Color: color.RGBA{R: 0xab, G: 0xcd, B: 0xef, A: 255}})

	if after := m.result.View(); after == before || !strings.Contains(ansi.Strip(after), "Combined policy") {
		t.Fatal("cached Markdown ignored the terminal palette or lost content")
	}
}

func BenchmarkUnchangedContentRefresh(b *testing.B) {
	for _, cached := range []bool{false, true} {
		name := "fresh-render"
		if cached {
			name = "cached-render"
		}

		b.Run(name, func(b *testing.B) {
			m := New(context.Background(), client.New("/nonexistent/octo-manager.sock"), theme.New(theme.Dark), time.UTC)

			b.Cleanup(func() {
				if err := m.Close(); err != nil {
					b.Error(err)
				}
			})

			m.snapshot = example()
			m.ensureSelection()
			m.panel = outputPanel
			m.Resize(layout.Size{Width: 132, Height: 40})

			b.ReportAllocs()

			for b.Loop() {
				if !cached {
					m.contentRender.valid = false
				}

				m.resizeContent()
			}
		})
	}
}
