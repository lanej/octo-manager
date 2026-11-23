package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/feedback"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/navigation"
	"github.com/lanej/charmed/text"
	charmedui "github.com/lanej/charmed/tui"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

type dashboardTab struct {
	id, label, title, purpose, region string
	global, worker                    bool
}

func tabDefinition(panel panelView) dashboardTab {
	switch panel {
	case reviewsPanel:
		return dashboardTab{id: "reviews", label: "1 Reviews", title: "REVIEW FEEDBACK", purpose: "Assess PR feedback and review decisions", region: "review-feedback"}
	case outputPanel:
		return dashboardTab{id: "output", label: "2 Output", title: "RUN OUTPUT", purpose: "Inspect the selected worker run and its tool activity", region: "run-output", worker: true}
	case statePanel:
		return dashboardTab{id: "state", label: "3 Runtime", title: "RUNTIME STATE", purpose: "Inspect scheduler health and persisted run transitions", region: "runtime-state", worker: true}
	case trackingPanel:
		return dashboardTab{id: "tracking", label: "4 Tracking", title: "PR TRACKING", purpose: "See ownership, blockers and the next merge step", region: "pr-tracking"}
	case activityPanel:
		return dashboardTab{id: "agent-activity", label: "3 Activity", title: "OPERATION", purpose: "Inspect requested effects, confirmed results and recovery", region: "agent-activity", global: true}
	case issuesPanel:
		return dashboardTab{id: "issues", label: "6 Issues", title: "ISSUE LIFECYCLE", purpose: "Coordinate investigation, implementation and acceptance", region: "issue-lifecycle", global: true}
	case githubPanel:
		return dashboardTab{id: "github", label: "5 GitHub", title: "GITHUB BUDGET", purpose: "Check API consumption, cooldowns and quota forecasts", region: "github-budget", global: true}
	case attentionPanel:
		return dashboardTab{id: "attention", label: "1 Attention", title: "NEXT STEP", purpose: "Decisions and exceptions across your repositories", region: "attention", global: true}
	case deliveriesPanel:
		return dashboardTab{id: "deliveries", label: "2 Deliveries", title: "DELIVERIES", purpose: "Current condition and next step for every GitHub delivery", region: "deliveries", global: true}
	case deliveryPanel:
		return dashboardTab{id: "delivery", label: "Delivery", title: "DELIVERY DETAIL", purpose: "One change, its evidence and the next required step", region: "delivery-detail", global: true}
	default:
		return dashboardTab{id: "unknown", label: "Unknown", title: "UNKNOWN VIEW", purpose: "Choose a dashboard tab", region: "unknown-view", global: true}
	}
}
func (m *Model) tab() dashboardTab { return tabDefinition(m.panel) }

func (m *Model) dashboardRecipe() layout.Node {
	tab := m.tab()
	region := func(id string, role layout.RegionRole) *layout.Region {
		return &layout.Region{ID: id, Role: role, Min: layout.Size{Width: 1, Height: 1}}
	}
	recipe := func(wide bool) layout.Variant {
		omitted := []layout.Omission{}

		var workspace layout.Node = region(tab.region, layout.ContentRegion)

		name := "focused"
		if wide {
			name = "wide"
		}

		if tab.worker {
			workspace = &layout.Responsive{Name: "worker-" + name, Variants: []layout.Variant{
				{Name: "visible", Min: layout.Size{Width: 32, Height: 12}, Root: &layout.Flex{Name: "run-workspace", Axis: layout.Vertical, Gap: 1, Children: []layout.Slot{{Node: workspace, Track: layout.Grow(3)}, {Node: region("worker", layout.SupportingRegion), Track: layout.Fixed(6)}}}},
				{Name: "hidden", Root: workspace, Hidden: []layout.Omission{{ID: "worker", Reason: "Short workspaces reserve space for the primary run view; resize to restore tool activity."}}},
			}}
		} else {
			omitted = append(omitted, layout.Omission{ID: "worker", Reason: "This tab is not worker-run inspection; output and runtime tabs retain worker activity."})
		}

		if wide && !tab.global && !m.expanded {
			railWidth := 36
			if m.operatorView() {
				railWidth = 42
			}

			workspace = &layout.Flex{Name: "pr-workspace", Axis: layout.Horizontal, Gap: 2, Children: []layout.Slot{{Node: region("pull-requests", layout.ContentRegion), Track: layout.Fixed(railWidth)}, {Node: workspace, Track: layout.Grow(28)}}}
		} else {
			omitted = append(omitted, layout.Omission{ID: "pull-requests", Reason: "Full-width or focused view; selected-item context and keyboard navigation remain available."})
		}

		body := &layout.Flex{Name: "tab-content", Axis: layout.Vertical, Children: []layout.Slot{{Node: region("navigation", layout.ChromeRegion), Track: layout.Fixed(1)}, {Node: region("context", layout.SupportingRegion), Track: layout.Fixed(2)}, {Node: workspace, Track: layout.Grow(3)}}}
		footer := &layout.Flex{Axis: layout.Vertical, Children: []layout.Slot{{Node: region("footer", layout.ChromeRegion), Track: layout.Fixed(1)}, {Node: region("notice", layout.ChromeRegion), Track: layout.Fixed(1)}}}

		return layout.Variant{Name: map[bool]string{true: "wide", false: "focused"}[wide], Root: &layout.Dock{Top: region("header", layout.ChromeRegion), TopHeight: len(m.header()), Bottom: footer, BottomHeight: 2, Body: body}, Hidden: omitted}
	}
	wide, focused := recipe(true), recipe(false)
	wide.Min = layout.Size{Width: 96, Height: 18}
	focused.Min = layout.Size{Width: 32, Height: 12}

	hidden := []layout.Omission{}
	for _, id := range []string{"header", "navigation", "context", "pull-requests", tab.region, "worker", "footer"} {
		hidden = append(hidden, layout.Omission{ID: id, Reason: "Terminal is too small for the dashboard; retain a visible quit control."})
	}

	emergency := region("notice", layout.ChromeRegion)
	emergency.Exceptions = []layout.Exception{{Rule: layout.SingleRegion, Reason: "Below 32×12 the dashboard reduces to a recovery surface with a quit control."}}

	return &layout.Responsive{Name: "dashboard-" + tab.id, Variants: []layout.Variant{wide, focused, {Name: "recovery", Root: emergency, Hidden: hidden}}}
}

type dashboardLayoutKey struct {
	panel        panelView
	expanded     bool
	headerHeight int
}

func (m *Model) dashboardScreen() (*charmedui.Screen, error) {
	key := dashboardLayoutKey{panel: m.panel, expanded: m.expanded, headerHeight: len(m.header())}
	if m.screen == nil || m.layoutKey != key {
		screen, err := charmedui.NewScreen("header", "navigation", "context", "pull-requests", m.tab().region, "worker", "footer", "notice")
		if err != nil {
			return nil, err
		}

		compiled, err := layout.Compile(m.dashboardRecipe())
		if err != nil {
			return nil, err
		}

		m.screen, m.compiled, m.layoutKey = screen, compiled, key
	}

	if err := m.screen.ArrangeCompiled(m.compiled, layout.Size{Width: max(1, m.size.Width), Height: max(1, m.size.Height)}); err != nil {
		return nil, err
	}

	return m.screen, nil
}

func (m *Model) dashboardContext(width int) string {
	tab := m.tab()

	var detail string

	switch m.panel {
	case trackingPanel, reviewsPanel:
		if pr := m.currentSubject().tracked; pr != nil {
			detail = m.automationLabel(pr.GetId())
			if merge := m.mergeStatus(pr.GetId()); merge != nil && merge.GetDetail() != "" {
				detail += " · " + safe(merge.GetDetail())
			}
		} else {
			detail = "Manual merge · PR is not enrolled for tracking"
		}
	case outputPanel, statePanel:
		detail = "Dispatch " + stateName(m.snapshot.GetScheduler().String(), "SCHEDULER_STATE_") + " · worker " + stateName(m.snapshot.GetWorker().String(), "WORKER_STATE_")
	case activityPanel:
		detail = "j/k select · h/l history pages · r reconcile a saved uncertain operation"
		if m.inspectingOperation() {
			detail = "j/k scroll · esc returns to activity · r reconciles the saved uncertain operation"
		}

		if m.operations.loading {
			detail = "Loading saved operations · previous evidence retained"
		}

		if m.operations.err != nil {
			detail = "Inspection unavailable · previous evidence retained · u retry"
		} else if m.agentActivity.err != nil {
			detail = "History incomplete · previous page retained · u retry"
		}
	case attentionPanel:
		detail = fmt.Sprintf("%d need intervention · %d GitHub deliveries · enter inspects the selected PR", m.attentionCount(), len(m.deliverySummaries()))
	case deliveriesPanel:
		detail = "j/k select · enter inspect · confirmed merge and task acceptance remain separate"
	case deliveryPanel:
		summary := m.summarizeDelivery(m.currentSubject())
		detail = summary.condition + " · " + summary.next
	case issuesPanel:
		detail = "h/l select issue · j/k scroll · CLI records approvals and answers"
	case githubPanel:
		detail = m.githubSummary()
	default:
		detail = "Choose a view using 1–3 · d diagnostics"
	}

	return layout.Fit(ansi.Truncate(m.theme.Subtle().Render(tab.purpose), width, "…")+"\n"+ansi.Truncate(text.Label(detail, m.theme), width, "…"), layout.Size{Width: width, Height: 2})
}

func (m *Model) dashboardView() string {
	screen, err := m.dashboardScreen()
	if err != nil {
		return layout.Fit("Dashboard layout unavailable: "+safe(err.Error())+"\nq quit", m.size)
	}

	tab := m.tab()
	views := map[string]charmedui.RegionView{}

	for _, region := range screen.Plan().Regions() {
		id := region.ID
		input := m.regionInput(id)
		revision := m.memo("region:" + id).update(input)
		views[id] = charmedui.RegionView{Revision: revision, Render: func(size layout.Size) string {
			switch id {
			case "header":
				return strings.Join(m.header(), "\n")
			case "navigation":
				items := []navigation.Tab{}

				for _, panel := range m.navigationPanels() {
					definition := tabDefinition(panel)
					items = append(items, navigation.Tab{ID: definition.id, Label: definition.label})
				}

				tabs := navigation.NewTabs(items, m.theme)

				selected := tab.id
				if m.panel == deliveryPanel {
					selected = tabDefinition(deliveriesPanel).id
				}

				tabs.Select(selected)
				tabs.SetWidth(size.Width)

				return tabs.View()
			case "context":
				return m.dashboardContext(size.Width)
			case "pull-requests":
				return m.queue(geometry{left: size.Width, body: size.Height})
			case "worker":
				inner := layout.PanelContentSize(size)
				lines := m.workerLines()

				worker := strings.Join(lines, "\n")
				if inner.Height > len(lines) {
					worker += "\n" + m.activity.View()
				}

				return layout.Panel("WORKER · recent tools · "+m.zoneLabel(), worker, size, m.theme, m.focus.Current() == "activity")
			case "footer":
				return (layout.Footer{Help: m.dashboardHelp(), Status: "dispatch " + stateName(m.snapshot.GetScheduler().String(), "SCHEDULER_STATE_")}).View(size.Width, m.theme)
			case "notice":
				notice := m.dashboardNotice(size.Width)

				if m.connectionError != "" {
					notice = m.connectionError
				}

				if m.commandError != "" {
					notice = m.commandError
				}

				if screen.Plan().Variant() == "recovery" {
					notice = strings.Repeat("\n", max(0, size.Height-1)) + "q quit"
				}

				return layout.Fit(m.theme.Subtle().Render(notice), size)
			default:
				if m.workspacePanel() {
					return layout.Fit(m.resultContent, size)
				}

				bar := feedback.Scrollbar{Total: m.result.TotalLineCount(), Visible: m.result.Height(), Offset: m.result.YOffset(), Height: m.result.Height()}
				content := layout.Row(m.result.View(), bar.View(m.theme))

				return layout.Panel(tab.title, content, size, m.theme, m.focus.Current() == "result")
			}
		}}
	}

	frame, err := screen.RenderRetained(views)
	if err != nil {
		return layout.Fit("Dashboard rendering unavailable: "+safe(err.Error())+"\nq quit", m.size)
	}

	return frame.Content
}

func (m *Model) dashboardHelp() string {
	switch m.panel {
	case attentionPanel, deliveriesPanel:
		return "j/k select · enter inspect · g GitHub · [/] scroll"
	case deliveryPanel:
		return "esc back · g GitHub · a auto-merge · [/] scroll"
	case activityPanel:
		if inspector := m.currentWorkspace(); inspector != nil && inspector.Inspecting() {
			return "esc list · j/k scroll · g GitHub · r reconcile · [/] scroll"
		}

		return "j/k select · enter inspect · esc list · g GitHub · r reconcile · [/] scroll"
	case reviewsPanel, outputPanel, statePanel, trackingPanel, githubPanel, issuesPanel:
	default:
		return "d diagnostics · q quit"
	}

	if m.globalPanel() {
		return "[/] scroll · u refresh local data"
	}

	return "o browser · [/] scroll · tab pane · enter expand"
}

func (m *Model) dashboardNotice(width int) string {
	if m.operatorView() {
		if width < 80 {
			return "1–3 views · d diagnostics · q quit"
		}

		return "1 Attention · 2 Deliveries · 3 Activity · d diagnostics · u refresh · q detach"
	}

	if width < 80 {
		return "1–6 diagnostics · esc back · q quit"
	}

	if m.tab().worker {
		return "h/l runs · p pause · c cancel · r retry · 1–6 diagnostics · esc back · q detach"
	}

	return "1–6 diagnostics · esc back · u refresh · q detach"
}

func (m *Model) mergeStatus(id string) *v1.MergeStatus {
	var result *v1.MergeStatus

	for _, entry := range m.snapshot.GetMergeStatuses() {
		if entry.GetPrId() == id {
			result = entry
		}
	}

	return result
}

func (m *Model) automationLabel(id string) string {
	merge := m.mergeStatus(id)
	if merge.GetState() == "merged" {
		if merge.GetAutoMerge() {
			return "Merged · auto-merge was ON"
		}

		return "Merged"
	}

	for _, pr := range m.snapshot.GetTracking().GetPrs() {
		if pr.GetId() != id {
			continue
		}

		switch pr.GetObservation().GetLifecycle() {
		case "merged":
			return "Merged"
		case "closed":
			return "Closed"
		}
	}

	if merge.GetChainState() == "cancelled" && merge.GetState() != "cancelled" {
		return "Auto-merge stopped · reconciling"
	}

	if merge.GetState() == "cancelled" {
		return "Auto-merge stopped"
	}

	if !merge.GetAutoMerge() {
		if merge.GetAutoMergeSource() == "inherited" {
			return "Manual merge · inherited"
		}

		return "Manual merge"
	}

	if merge.GetChainState() == "paused" {
		return "Auto-merge paused"
	}

	if merge.GetAutoMergeSource() == "inherited" {
		if merge.GetAutoMergeStage() != "" {
			return "Auto-merge ON · inherited (" + merge.GetAutoMergeStage() + ")"
		}

		return "Auto-merge ON · inherited"
	}

	return "Auto-merge ON"
}
