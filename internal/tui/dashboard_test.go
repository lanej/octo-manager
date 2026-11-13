package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func TestEachTabDeclaresItsWholeResponsiveScreen(t *testing.T) {
	t.Parallel()

	for _, panel := range []panelView{reviewsPanel, outputPanel, statePanel, trackingPanel, activityPanel, githubPanel} {
		m := model(t, theme.Dark)
		address := "https://github.com/owner/repo/pull/31"
		m.snapshot.Jobs = []*v1.Job{prJob("run", address)}
		m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{{Id: "pr", Url: address, Enabled: true}}}
		m.snapshot.MergeStatuses = []*v1.MergeStatus{{PrId: "pr", AutoMerge: true, State: "waiting_owner", ChainState: "active"}}
		m.snapshot.GithubUsage = usageExample()
		m.selected = ""
		m.ensureSelection()
		m.panel = panel
		m.Resize(layout.Size{Width: 132, Height: 40})

		screen, err := m.dashboardScreen()
		if err != nil {
			t.Fatal(err)
		}

		_, err = screen.CheckLayouts(m.dashboardRecipe(), layout.Size{Width: 132, Height: 40}, layout.Size{Width: 96, Height: 18}, layout.Size{Width: 80, Height: 32}, layout.Size{Width: 40, Height: 12}, layout.Size{Width: 12, Height: 5})
		if err != nil {
			t.Fatalf("%s: %v", m.tab().id, err)
		}

		for _, size := range []layout.Size{{Width: 160, Height: 44}, {Width: 132, Height: 40}, {Width: 96, Height: 18}, {Width: 80, Height: 32}, {Width: 40, Height: 12}, {Width: 12, Height: 5}, {Width: 1, Height: 1}} {
			m.Resize(size)

			view := ansi.Strip(m.View())
			if strings.Contains(view, "layout unavailable") || strings.Contains(view, "rendering unavailable") {
				t.Fatalf("%s %v: %s", m.tab().id, size, view)
			}

			if len(strings.Split(view, "\n")) != size.Height {
				t.Fatalf("%s exceeded %v", m.tab().id, size)
			}

			for _, line := range strings.Split(view, "\n") {
				if ansi.StringWidth(line) > size.Width {
					t.Fatalf("%s line overflow at%v", m.tab().id, size)
				}
			}
		}
	}
}

func TestAutoMergeLabelsFollowCoordinatorState(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{{Id: "pr", Url: "https://github.com/owner/repo/pull/31", Enabled: true}}}
	m.snapshot.Jobs = nil
	m.selected = ""
	m.ensureSelection()

	m.panel = trackingPanel
	for _, test := range []struct {
		enabled             bool
		state, chain, label string
	}{{false, "waiting_owner", "active", "Manual merge"}, {true, "waiting_owner", "active", "Auto-merge ON"}, {true, "waiting_checks", "active", "Auto-merge ON"}, {true, "waiting_checks", "paused", "Auto-merge paused"}, {true, "merging", "cancelled", "Auto-merge stopped · reconciling"}, {true, "cancelled", "cancelled", "Auto-merge stopped"}, {true, "merged", "completed", "Merged · auto-merge was ON"}} {
		m.snapshot.MergeStatuses = []*v1.MergeStatus{{PrId: "pr", AutoMerge: test.enabled, State: test.state, ChainState: test.chain, Detail: "Owner assessment required"}}
		m.Resize(layout.Size{Width: 132, Height: 40})

		view := ansi.Strip(m.View())
		if !strings.Contains(view, test.label) {
			t.Fatalf("%s label absent: %s", test.state, view)
		}
	}
}

func TestReadOnlyTabsCannotIssueWorkerControls(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	for _, panel := range []panelView{reviewsPanel, trackingPanel, activityPanel, githubPanel} {
		m.panel = panel
		for _, key := range []string{"p", "c", "r"} {
			if m.key(tea.KeyPressMsg{Code: rune(key[0]), Text: key}) != nil || m.commandPending {
				t.Fatalf("%s exposed worker control%s", m.tab().id, key)
			}
		}
	}
}

func TestRuntimeAndTrackingRemainUsefulWithoutWorkerRuns(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Jobs = nil
	m.panel = statePanel
	m.Resize(layout.Size{Width: 132, Height: 40})

	view := ansi.Strip(m.View())
	for _, label := range []string{"Scheduler health", "Dispatch", "Worker slot", "independently"} {
		if !strings.Contains(view, label) {
			t.Fatalf("missing%s: %s", label, view)
		}
	}

	m.panel = githubPanel
	m.snapshot.GithubUsage = usageExample()
	m.Resize(layout.Size{Width: 132, Height: 40})

	view = ansi.Strip(m.View())
	if !strings.Contains(view, "REST QUOTA") || !strings.Contains(view, "GRAPHQL QUOTA") {
		t.Fatal("quota layout missing independent budgets")
	}
}

func TestTerminalPRWithoutMergeEntryHasOutcomeLabel(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	for _, state := range []string{"merged", "closed"} {
		m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{{Id: "pr", Observation: &v1.TrackingObservation{Lifecycle: state}}}}
		if label := m.automationLabel("pr"); !strings.EqualFold(label, state) {
			t.Fatalf("%s shown as %s", state, label)
		}
	}
}

func TestSelectionChangingDashboardFrameCannotRelabelOldReviews(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.dashboardStarted = true
	m.panel = reviewsPanel
	m.snapshot.Jobs = []*v1.Job{prJob("old", "https://github.com/owner/repo/pull/1")}
	m.selected = ""
	m.ensureSelection()
	m.syncDashboard()
	version := m.dashboardVersion
	fresh := example()
	fresh.Jobs = []*v1.Job{prJob("new", "https://github.com/owner/repo/pull/2")}
	m.applyDashboard(dashboardFrame{version: version, frame: &v1.WatchDashboardResponse{Snapshot: fresh, PullRequest: &v1.PullRequestDetails{Url: "https://github.com/owner/repo/pull/1", Title: "Old PR"}}})

	if m.dashboardVersion == version {
		t.Fatal("selection did not replace subscription")
	}

	if m.reviews["https://github.com/owner/repo/pull/2"] != nil {
		t.Fatal("old frame relabeled another PR")
	}
}

func TestQueuedReviewCacheMissIsPendingAndRetainsExistingContent(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	address := "https://github.com/owner/repo/pull/1"
	m.reviews[address] = &v1.PullRequestDetails{Title: "Existing review"}
	m.applyReview(reviewMsg{url: address, status: &v1.RefreshStatus{State: v1.RefreshState_REFRESH_STATE_QUEUED}})

	if !m.reviewLoading[address] || m.reviewErrors[address] != "" || m.reviews[address].GetTitle() != "Existing review" {
		t.Fatal("queued refresh discarded cached view or became an error")
	}
}
