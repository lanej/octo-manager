package tui

import (
	"reflect"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/text"
	"github.com/lanej/charmed/theme"
)

type contentRenderCache struct {
	source, rendered string
	width            int
	palette          theme.Theme
	document         *text.MarkdownDocument
	markdown, valid  bool
}

func (m *Model) renderedContent(source string, width int, markdown bool) string {
	width = max(1, width)

	cached := m.contentRender
	if cached.valid && cached.source == source && cached.width == width && reflect.DeepEqual(cached.palette, m.theme) && cached.markdown == markdown {
		return cached.rendered
	}

	var rendered string

	if markdown {
		styles := text.MarkdownStyles(m.theme)
		styles.Strong.BlockPrefix, styles.Strong.BlockSuffix = "", ""
		styles.Emph.BlockPrefix, styles.Emph.BlockSuffix = "", ""

		document := cached.document
		if !cached.valid || cached.source != source || !reflect.DeepEqual(cached.palette, m.theme) || !cached.markdown {
			var err error

			document, err = text.PrepareMarkdown(source, m.theme, text.MarkdownOptions{Styles: &styles})
			if err != nil {
				m.contentRender = contentRenderCache{}
				return safe(source)
			}
		}

		value, err := document.Render(width)
		if err != nil {
			m.contentRender.valid = false

			return safe(source)
		}

		rendered = value
		cached.document = document
	} else {
		rendered = ansi.Wrap(source, width, " ")
	}

	m.contentRender = contentRenderCache{}
	if len(source) <= 256*1024 && len(rendered) <= 1024*1024 {
		m.contentRender = contentRenderCache{source: source, rendered: rendered, width: width, palette: m.theme, document: cached.document, markdown: markdown, valid: true}
	}

	return rendered
}
