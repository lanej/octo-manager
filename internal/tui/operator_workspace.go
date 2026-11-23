package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/pattern"
	"github.com/lanej/charmed/text"
)

type operatorWorkspace struct {
	inspector *pattern.ListInspector
	size      layout.Size
	revision  uint64
}

func (m *Model) workspacePanel() bool {
	return m.operatorList() || m.panel == activityPanel
}

func (m *Model) currentWorkspace() *pattern.ListInspector {
	if workspace := m.operatorWorkspaces[m.panel]; workspace != nil {
		return workspace.inspector
	}

	return nil
}

func (m *Model) inspectingOperation() bool {
	inspector := m.currentWorkspace()
	return m.panel == activityPanel && inspector != nil && inspector.Inspecting()
}

func (m *Model) resizeOperatorWorkspace(size layout.Size) {
	if m.operatorWorkspaces == nil {
		m.operatorWorkspaces = make(map[panelView]*operatorWorkspace)
	}

	workspace := m.operatorWorkspaces[m.panel]
	if workspace == nil {
		inspector, err := pattern.NewListInspector(nil, size, m.theme)
		if err != nil {
			m.commandError = "Workspace unavailable: " + safe(err.Error())
			return
		}

		workspace = &operatorWorkspace{inspector: inspector}
		m.operatorWorkspaces[m.panel] = workspace
	}

	inspector := workspace.inspector
	input := m.contentInput(size.Width)

	revision := m.memo("pane-source").update(input)
	if workspace.revision != revision {
		inspector.Theme = m.theme
		inspector.ListWidth, inspector.MinDetailWidth = 42, 48
		inspector.Preview = m.panel != deliveriesPanel
		inspector.ListTitle, inspector.DetailTitle = "DELIVERIES", "NEXT STEP"
		inspector.Empty = "No GitHub deliveries yet.\n\nTrack or submit a PR from its owning session.\n\nPress d for runtime and issue diagnostics."

		switch m.panel {
		case attentionPanel:
			inspector.ListTitle = fmt.Sprintf("ATTENTION · %d", m.attentionCount())
		case activityPanel:
			inspector.ListTitle, inspector.DetailTitle = "ACTIVITY", "OPERATION"
			inspector.Empty = m.operationEmpty()
		case deliveriesPanel, deliveryPanel, reviewsPanel, outputPanel, statePanel, trackingPanel, githubPanel, issuesPanel:
		default:
		}

		if err := inspector.SetRecords(m.operatorRecords()); err != nil {
			m.commandError = "Workspace update unavailable: " + safe(err.Error())
		} else {
			workspace.revision = revision
		}
	}

	selected := m.currentSubject().key
	if m.panel == activityPanel {
		selected = m.operations.selected
	}

	if current, present := inspector.SelectedID(); selected != "" && (!present || current != selected) {
		inspector.Select(selected)
	}

	if workspace.size != size {
		inspector.Resize(size)
		workspace.size = size
	}

	m.retainOperatorView(inspector)
}

func (m *Model) retainOperatorView(inspector *pattern.ListInspector) {
	m.resultContent = inspector.View()

	m.result = inspector.List
	if inspector.Inspecting() {
		m.result = inspector.Detail
	}
}

func (m *Model) updateOperatorWorkspace(message tea.Msg) tea.Cmd {
	inspector := m.currentWorkspace()
	if inspector == nil {
		m.resizeContent()
		inspector = m.currentWorkspace()
	}

	if inspector == nil {
		return nil
	}

	command := inspector.Update(message)
	if selected, present := inspector.SelectedID(); present {
		if m.panel == activityPanel {
			m.operations.selected = selected
		} else if selected != m.selected {
			m.selected = selected
			m.history = historyState{version: m.history.version + 1}
		}
	}

	m.retainOperatorView(inspector)

	return tea.Batch(command, m.loadReviews(false))
}

func (m *Model) operatorRecords() []pattern.InspectorRecord {
	if m.panel == activityPanel {
		items := m.operatorActivityItems()

		records := make([]pattern.InspectorRecord, 0, len(items))
		for _, item := range items {
			records = append(records, pattern.InspectorRecord{
				ID: item.id,
				Row: func(width int, _ bool) string {
					title, detail := m.operationRow(item)
					return wrapDeliveryContent(title+"\n"+detail+"\n"+m.muted(m.activityTime(item.at)), width)
				},
				Detail: func(width int) string { return m.operationItemContent(item, width) },
			})
		}

		return records
	}

	items := m.deliverySummaries()

	records := make([]pattern.InspectorRecord, 0, len(items))
	for index, summary := range items {
		heading := ""
		if index == 0 || summary.group != items[index-1].group {
			heading = deliveryGroupTitle(summary.group)
		}

		inventory := m.panel == deliveriesPanel

		records = append(records, pattern.InspectorRecord{
			ID: summary.item.key, Heading: heading,
			Row: func(width int, selected bool) string {
				identity := m.link(summary.item.url)
				if selected {
					identity = m.theme.Heading().Render(identity)
				}

				lines := []string{identity}
				if summary.title != summary.item.label {
					lines = append(lines, text.Label(summary.title, m.theme))
				}

				lines = append(lines, text.Pill(summary.condition, summary.tone, m.theme, text.Normal), m.field("Next", summary.next))
				if inventory {
					lines = append(lines, m.muted("Observed "+m.deliveryObservedAt(summary.observedAt)))
				}

				return wrapDeliveryContent(strings.Join(lines, "\n"), width)
			},
			Detail: func(width int) string { return m.deliveryPreview(summary.item, width) },
		})
	}

	return records
}

func (m *Model) operationEmpty() string {
	if m.operations.loading {
		return "Loading saved operations; waiting for coordinator evidence."
	}

	if m.operations.err != nil {
		return "Inspection unavailable: " + safe(m.operations.err.Error()) + " · u retry"
	}

	if m.agentActivity.err != nil {
		return "History incomplete: " + safe(m.agentActivity.err.Error()) + " · u retry"
	}

	if m.agentActivity.loading {
		return "Loading activity history."
	}

	return "No operations observed yet. Saved effects and recorded activity appear here."
}
