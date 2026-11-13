package tui

import (
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/text"
	"github.com/lanej/charmed/theme"
)

type contentRenderCache struct {
	source, rendered string
	width            int
	mode             theme.Mode
	markdown, valid  bool
}

func (m *Model) renderedContent(source string, width int, markdown bool) string {
	width = max(1, width)

	cached := m.contentRender
	if cached.valid && cached.source == source && cached.width == width && cached.mode == m.theme.Mode && cached.markdown == markdown {
		return cached.rendered
	}

	var rendered string

	if markdown {
		styles := text.MarkdownStyles(m.theme)
		styles.Strong.BlockPrefix, styles.Strong.BlockSuffix = "", ""
		styles.Emph.BlockPrefix, styles.Emph.BlockSuffix = "", ""

		value, err := text.Markdown(source, width, m.theme, text.MarkdownOptions{Styles: &styles})
		if err != nil {
			m.contentRender.valid = false

			return safe(source)
		}

		rendered = value
	} else {
		rendered = ansi.Wrap(source, width, " ")
	}

	m.contentRender.valid = false
	if len(source) <= 256*1024 && len(rendered) <= 1024*1024 {
		m.contentRender = contentRenderCache{source: source, rendered: rendered, width: width, mode: m.theme.Mode, markdown: markdown, valid: true}
	}

	return rendered
}
