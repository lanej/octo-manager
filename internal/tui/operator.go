package tui

import tea "charm.land/bubbletea/v2"

func (m *Model) operatorList() bool {
	return m.panel == attentionPanel || m.panel == deliveriesPanel
}

func (m *Model) operatorView() bool {
	return m.operatorList() || m.panel == deliveryPanel || m.panel == activityPanel
}

func (m *Model) wantsReviews() bool {
	return m.panel == reviewsPanel || m.panel == attentionPanel || m.panel == deliveryPanel
}

func (m *Model) navigationPanels() []panelView {
	if m.operatorView() {
		return []panelView{attentionPanel, deliveriesPanel, activityPanel}
	}

	return []panelView{reviewsPanel, outputPanel, statePanel, trackingPanel, githubPanel, issuesPanel}
}

func (m *Model) navigate(key string) (tea.Cmd, bool) {
	if key == "d" || key == "?" {
		if m.operatorView() {
			m.diagnosticsOrigin = m.panel
			m.panel = githubPanel
		} else {
			m.panel = m.diagnosticsOrigin
		}

		m.expanded = false
		m.result.GotoTop()
		m.ensureSelection()
		m.resizeContent()

		return m.refresh(), true
	}

	if key == "esc" || key == "backspace" {
		if inspector := m.currentWorkspace(); m.workspacePanel() && inspector != nil && inspector.Inspecting() {
			inspector.Back()
			m.retainOperatorView(inspector)

			return nil, true
		}

		switch {
		case !m.operatorView():
			m.panel = m.diagnosticsOrigin
		case m.panel == deliveryPanel:
			m.panel = m.detailOrigin
		default:
			return nil, true
		}

		m.expanded = false
		m.result.GotoTop()
		m.ensureSelection()
		m.resizeContent()

		return nil, true
	}

	if len(key) != 1 || key[0] < '1' || key[0] > '6' {
		return nil, false
	}

	panels := m.navigationPanels()
	index := int(key[0] - '1')

	if index >= len(panels) {
		return nil, true
	}

	m.panel = panels[index]
	m.expanded = false
	m.result.GotoTop()
	m.ensureSelection()
	m.panel = panels[index]
	m.resizeContent()

	switch m.panel {
	case activityPanel:
		return tea.Batch(m.loadActivity(), m.loadOperations(false)), true
	case statePanel:
		return m.loadHistory(), true
	case reviewsPanel:
		return m.loadReviews(false), true
	case attentionPanel, deliveriesPanel, deliveryPanel, outputPanel, trackingPanel, githubPanel, issuesPanel:
		return nil, true
	default:
		return nil, true
	}
}

func (m *Model) inspectDelivery() tea.Cmd {
	if m.currentSubject().url == "" {
		return nil
	}

	m.detailOrigin = m.panel
	m.panel = deliveryPanel
	m.expanded = false
	m.result.GotoTop()
	m.resizeContent()

	return m.loadReviews(false)
}

func (m *Model) openOperationPR() tea.Cmd {
	address := m.currentOperationURL()
	if address == "" {
		m.commandError = "This operation has no GitHub PR URL."
		return nil
	}

	return m.openBrowser(address)
}

func deliveryGroupTitle(group deliveryGroup) string {
	switch group {
	case attentionDeliveries:
		return "Needs intervention"
	case movingDeliveries:
		return "In progress"
	case settledDeliveries:
		return "Delivered / closed"
	default:
		return "Other deliveries"
	}
}

func (m *Model) attentionCount() int {
	count := 0

	for _, item := range m.deliverySummaries() {
		if item.group == attentionDeliveries {
			count++
		}
	}

	return count
}
