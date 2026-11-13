package tui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/feedback"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/navigation"
	"github.com/lanej/charmed/text"
	charmedui "github.com/lanej/charmed/tui"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
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
		return dashboardTab{id: "agent-activity", label: "5 Activity", title: "AGENT ACTIVITY", purpose: "Follow reported agent operations across sessions", region: "agent-activity", global: true}
	case githubPanel:
		return dashboardTab{id: "github", label: "6 GitHub", title: "GITHUB BUDGET", purpose: "Check API consumption, cooldowns and quota forecasts", region: "github-budget", global: true}
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
			workspace = &layout.Flex{Name: "pr-workspace", Axis: layout.Horizontal, Gap: 2, Children: []layout.Slot{{Node: region("pull-requests", layout.ContentRegion), Track: layout.Fixed(36)}, {Node: workspace, Track: layout.Grow(28)}}}
		} else {
			omitted = append(omitted, layout.Omission{ID: "pull-requests", Reason: "Global or focused view; PR navigation remains available with j/k on PR tabs."})
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

func (m *Model) dashboardScreen() (*charmedui.Screen, error) {
	screen, err := charmedui.NewScreen("header", "navigation", "context", "pull-requests", m.tab().region, "worker", "footer", "notice")
	if err != nil {
		return nil, err
	}

	if err = screen.Arrange(m.dashboardRecipe(), layout.Size{Width: max(1, m.size.Width), Height: max(1, m.size.Height)}); err != nil {
		return nil, err
	}

	return screen, nil
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
		detail = "All sessions · named operations, outcomes and related PRs"
	case githubPanel:
		detail = m.githubSummary()
	default:
		detail = "Choose a tab using 1–6"
	}

	return layout.Fit(ansi.Truncate(m.theme.Subtle().Render(tab.purpose), width, "…")+"\n"+ansi.Truncate(text.Label(detail, m.theme), width, "…"), layout.Size{Width: width, Height: 2})
}

func (m *Model) dashboardView() string {
	screen, err := m.dashboardScreen()
	if err != nil {
		return layout.Fit("Dashboard layout unavailable: "+safe(err.Error())+"\nq quit", m.size)
	}

	tab := m.tab()
	views := map[string]string{}

	for _, region := range screen.Plan().Regions() {
		size := layout.Size{Width: region.Bounds.Dx(), Height: region.Bounds.Dy()}
		switch region.ID {
		case "header":
			views[region.ID] = strings.Join(m.header(), "\n")
		case "navigation":
			items := []navigation.Tab{}

			for _, panel := range []panelView{reviewsPanel, outputPanel, statePanel, trackingPanel, activityPanel, githubPanel} {
				definition := tabDefinition(panel)
				items = append(items, navigation.Tab{ID: definition.id, Label: definition.label})
			}

			tabs := navigation.NewTabs(items, m.theme)
			tabs.Select(tab.id)
			tabs.SetWidth(size.Width)
			views[region.ID] = tabs.View()
		case "context":
			views[region.ID] = m.dashboardContext(size.Width)
		case "pull-requests":
			views[region.ID] = m.queue(geometry{left: size.Width, body: size.Height})
		case "worker":
			inner := layout.PanelContentSize(size)
			lines := m.workerLines()

			worker := strings.Join(lines, "\n")
			if inner.Height > len(lines) {
				worker += "\n" + m.activity.View()
			}

			views[region.ID] = layout.Panel("WORKER · recent tools · "+m.zoneLabel(), worker, size, m.theme, m.focus.Current() == "activity")
		case "footer":
			views[region.ID] = (layout.Footer{Help: m.dashboardHelp(), Status: "dispatch " + stateName(m.snapshot.GetScheduler().String(), "SCHEDULER_STATE_")}).View(size.Width, m.theme)
		case "notice":
			notice := "j/k PRs · u refresh · 1–6 tabs · q quit"
			if m.panel == trackingPanel {
				notice = "j/k PRs · a auto-merge · 1–6 tabs · q quit"
			} else if tab.global {
				notice = "j/k scroll · u refresh · 1–6 tabs · q quit"
			}

			if size.Width < 80 {
				notice = "1–6 tabs · q quit · j/k PRs"
				if m.panel == trackingPanel {
					notice = "a auto-merge · 1–6 tabs · q quit"
				} else if tab.global {
					notice = "j/k scroll · 1–6 tabs · q quit"
				}
			} else if tab.worker {
				notice = "j/k PRs · h/l runs · p pause · c cancel · r retry · 1–6 tabs · q quit"
			}

			if m.connectionError != "" {
				notice = m.connectionError
			}

			if m.commandError != "" {
				notice = m.commandError
			}

			if screen.Plan().Variant() == "recovery" {
				notice = strings.Repeat("\n", max(0, size.Height-1)) + "q quit"
			}

			views[region.ID] = layout.Fit(m.theme.Subtle().Render(notice), size)
		default:
			bar := feedback.Scrollbar{Total: m.result.TotalLineCount(), Visible: m.result.Height(), Offset: m.result.YOffset(), Height: m.result.Height()}
			content := layout.Row(m.result.View(), bar.View(m.theme))
			views[region.ID] = layout.Panel(tab.title, content, size, m.theme, m.focus.Current() == "result")
		}
	}

	frame, err := screen.Render(views)
	if err != nil {
		return layout.Fit("Dashboard rendering unavailable: "+safe(err.Error())+"\nq quit", m.size)
	}

	return frame.Content
}

func (m *Model) dashboardHelp() string {
	if m.globalPanel() {
		return "[/] scroll · u refresh local data"
	}

	return "o browser · [/] scroll · tab pane · enter expand"
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
		return "Manual merge"
	}

	if merge.GetChainState() == "paused" {
		return "Auto-merge paused"
	}

	return "Auto-merge ON"
}
