package tui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	charmedui "github.com/lanej/charmed/tui"
)

type dashboardSection struct {
	id, title string
	content   func(int) string
}

func (m *Model) sections(name string, width int, sections ...dashboardSection) string {
	width = max(1, width)
	columns := width >= 112 && len(sections) == 2

	gap := 1
	if columns {
		gap = 2
	}

	widths := make([]int, len(sections))
	heights := make([]int, len(sections))
	contents := make([]string, len(sections))
	ids := make([]string, len(sections))
	slots := make([]layout.Slot, 0, len(sections))
	total := 0

	for i, section := range sections {
		ids[i] = section.id

		widths[i] = width
		if columns {
			widths[i] = (width - gap) / 2
			if i == 1 {
				widths[i] = width - gap - widths[0]
			}
		}

		inner := layout.PanelContentSize(layout.Size{Width: widths[i]})
		contents[i] = ansi.Wrap(section.content(max(1, inner.Width)), max(1, inner.Width), " ")
		heights[i] = len(strings.Split(contents[i], "\n")) + 2

		track := layout.Fixed(heights[i])
		if columns {
			track = layout.Grow(min(55, width))
		}

		slots = append(slots, layout.Slot{Node: &layout.Region{ID: section.id, Min: layout.Size{Width: min(55, width), Height: heights[i]}}, Track: track})
		if columns {
			total = max(total, heights[i])
		} else {
			total += heights[i]
			if i > 0 {
				total += gap
			}
		}
	}

	screen, err := charmedui.NewScreen(ids...)
	if err != nil {
		return m.muted("Section layout unavailable: " + err.Error())
	}

	axis := layout.Vertical
	if columns {
		axis = layout.Horizontal
	}

	if err = screen.Arrange(&layout.Flex{Name: name, Axis: axis, Gap: gap, Children: slots}, layout.Size{Width: width, Height: total}); err != nil {
		return m.muted("Section layout unavailable: " + err.Error())
	}

	views := map[string]string{}

	for i, section := range sections {
		bounds, _ := screen.Region(section.id)
		views[section.id] = layout.Panel(section.title, contents[i], layout.Size{Width: bounds.Dx(), Height: bounds.Dy()}, m.theme, false)
	}

	frame, err := screen.Render(views)
	if err != nil {
		return m.muted("Section rendering unavailable: " + err.Error())
	}

	return frame.Content
}
