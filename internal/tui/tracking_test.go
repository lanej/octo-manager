package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/text"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func TestTrackedPRWithoutWorkerAndNavigation(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Tracking = &v1.TrackingSnapshot{
		Prs:        []*v1.TrackedPullRequest{{Id: "tracked", Url: "https://github.com/lanej/octo-manager/pull/1", OwnerAgentId: "agent", OriginAgentId: "agent", Enabled: true, Observation: &v1.TrackingObservation{Id: 1, Lifecycle: "open", Mergeability: "conflicting", HeadSha: "abc123", BaseSha: "def456", ObservedAtMs: 1000}}},
		Agents:     []*v1.AgentReference{{Id: "agent", Target: &v1.AgentTarget{Harness: "codex", Endpoint: "local", SessionId: "owning-thread"}, HarnessVersion: new("0.167.0")}},
		Actions:    []*v1.PendingAction{{Id: "action", PrId: "tracked", Summary: "Merge conflict", State: v1.ActionState_ACTION_STATE_OPEN, Profile: &v1.ExecutionProfile{Name: "conflict", Instructions: "Inspect both branches"}, EvidenceUrl: "https://github.com/lanej/octo-manager/pull/1"}},
		Deliveries: []*v1.ActionDelivery{{Id: "delivery", ActionId: "action", RecipientAgentId: "agent", State: v1.DeliveryState_DELIVERY_STATE_UNCERTAIN}},
	}
	m.selected = ""
	m.ensureSelection()

	if m.job() != nil || m.panel != trackingPanel {
		t.Fatal("tracked PR without jobs did not select tracking")
	}

	for _, size := range []layout.Size{{Width: 132, Height: 40}, {Width: 80, Height: 32}, {Width: 40, Height: 16}} {
		m.Resize(size)

		view := m.View()
		if len(strings.Split(view, "\n")) != size.Height {
			t.Fatal("wrong terminal height")
		}

		for _, line := range strings.Split(view, "\n") {
			if ansi.StringWidth(line) > size.Width {
				t.Fatal("tracking exceeds terminal width")
			}
		}

		if size.Width >= 80 && (!strings.Contains(view, "Owner:") || !strings.Contains(view, "conflicting")) {
			t.Fatal("owner and observed state missing")
		}
	}

	m.key(tea.KeyPressMsg{Code: 'j', Text: "j"})

	if m.job() == nil {
		t.Fatal("could not move to existing demo")
	}

	m.key(tea.KeyPressMsg{Code: 'k', Text: "k"})

	if m.currentSubject().tracked == nil {
		t.Fatal("could not return to tracked PR")
	}
}

func TestTrackingAtomsKeepLiveWorkAheadOfHistory(t *testing.T) {
	t.Parallel()

	for _, mode := range []theme.Mode{theme.Dark, theme.Light, theme.Contrast, theme.Mono} {
		m := model(t, mode)
		m.snapshot.Jobs = nil
		m.snapshot.Tracking = &v1.TrackingSnapshot{
			Prs:        []*v1.TrackedPullRequest{{Id: "tracked", Url: "https://github.com/owner/repo/pull/1", Enabled: true}},
			Actions:    []*v1.PendingAction{{Id: "old", PrId: "tracked", Summary: "Historical conflict", State: v1.ActionState_ACTION_STATE_SUPERSEDED}, {Id: "current", PrId: "tracked", Summary: "Current conflict", State: v1.ActionState_ACTION_STATE_OPEN}},
			Deliveries: []*v1.ActionDelivery{{ActionId: "current", State: v1.DeliveryState_DELIVERY_STATE_DELIVERED}},
		}
		m.ensureSelection()

		source := ansi.Strip(m.trackingContent())
		if strings.Index(source, "Current conflict") > strings.Index(source, "Historical conflict") || !strings.Contains(source, "delivered") || !strings.Contains(source, "verified resolution are separate") {
			t.Fatal("atom presentation obscured current work or delivery semantics")
		}

		if deliveryTone(v1.DeliveryState_DELIVERY_STATE_DELIVERED) == text.Success {
			t.Fatal("delivery acceptance was styled as verified success")
		}

		m.Resize(layout.Size{Width: 40, Height: 20})

		for _, line := range strings.Split(m.View(), "\n") {
			if ansi.StringWidth(line) > 40 {
				t.Fatal("atom view exceeds narrow terminal")
			}
		}
	}
}

func TestRebaseRepairUsesReadableStateAndPreservesNarrowLayout(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Jobs = nil
	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{{Id: "pr", Url: "https://github.com/owner/repo/pull/42", Enabled: true}}}
	m.snapshot.Repairs = []*v1.RepairAttempt{{Id: "internal-repair-id", PrId: "pr", PrUrl: "https://github.com/owner/repo/pull/42", State: v1.RepairState_REPAIR_STATE_AWAITING_CHECKS, Detail: "Rebased branch pushed; waiting for GitHub verification", ResultHead: new(strings.Repeat("a", 40)), Harness: "pi", Model: "repair-model"}}
	m.ensureSelection()

	content := ansi.Strip(m.trackingContent())
	for _, want := range []string{"awaiting checks", "waiting for GitHub verification", "Git tools", "owner/repo@aaaaaaaa"} {
		if !strings.Contains(content, want) {
			t.Errorf("missing repair information %q", want)
		}
	}

	if strings.Contains(content, "internal-repair-id") || strings.Contains(content, "repair-model") {
		t.Fatal("Git-only repair exposed internal identity or claimed an agent was used")
	}

	m.snapshot.Repairs[0].UsedAgent = true
	if !strings.Contains(ansi.Strip(m.trackingContent()), "pi · repair-model") {
		t.Fatal("separate repair profile is missing")
	}

	for _, size := range []layout.Size{{Width: 132, Height: 40}, {Width: 80, Height: 32}, {Width: 40, Height: 16}} {
		m.Resize(size)

		for _, line := range strings.Split(m.View(), "\n") {
			if ansi.StringWidth(line) > size.Width {
				t.Fatal("repair view exceeds terminal width")
			}
		}
	}
}

func TestClosedPRKeepsAcknowledgedFailureInHistoryWithoutPendingWork(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	m.snapshot.Jobs = nil
	pr := &v1.TrackedPullRequest{Id: "pr", Url: "https://github.com/owner/repo/pull/292", Enabled: true, Observation: &v1.TrackingObservation{Lifecycle: "open"}}
	action := &v1.PendingAction{Id: "report", PrId: "pr", Summary: "Failed check: macOS", State: v1.ActionState_ACTION_STATE_ACKNOWLEDGED}
	m.snapshot.Tracking = &v1.TrackingSnapshot{
		Prs:     []*v1.TrackedPullRequest{pr},
		Actions: []*v1.PendingAction{action},
		Deliveries: []*v1.ActionDelivery{{
			ActionId: "report", State: v1.DeliveryState_DELIVERY_STATE_DELIVERED,
			ProgressJson:    `{"note":"Included in one queued digest; receipt pending."}`,
			MessageSequence: new(uint64(1)), AcknowledgedAtMs: new(int64(1000)),
		}},
	}
	m.ensureSelection()
	m.Resize(layout.Size{Width: 132, Height: 40})

	if m.openActions("pr") != 1 || !strings.Contains(ansi.Strip(m.View()), "1 outstanding action") {
		t.Fatal("open PR lost its acknowledged action")
	}

	for _, lifecycle := range []string{"merged", "closed"} {
		pr.Observation.Lifecycle = lifecycle

		m.Update(snapshotMsg{snapshot: m.snapshot})

		content := ansi.Strip(m.trackingContent())
		for _, expected := range []string{"0 outstanding actions", "Action history", "acknowledged", "Failed check: macOS", "Agent received", "retained as history"} {
			if !strings.Contains(content, expected) {
				t.Fatalf("closed PR omitted %q", expected)
			}
		}

		if m.openActions("pr") != 0 || strings.Contains(content, "receipt pending") || action.GetState() != v1.ActionState_ACTION_STATE_ACKNOWLEDGED {
			t.Fatal("historical report looks pending or changed its recorded state")
		}

		if !strings.Contains(ansi.Strip(m.View()), "0 runs · 0 actions") {
			t.Fatal("sidebar still counts historical reports as active work")
		}
	}

	for _, lifecycle := range []string{"", "unknown", "open"} {
		pr.Observation.Lifecycle = lifecycle

		if m.openActions("pr") != 1 {
			t.Fatal("missing lifecycle evidence silently hid an unfinished action")
		}
	}
}

func TestPRSidebarMentionsJobsOnlyWhenLocalJobsExist(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	job := m.snapshot.Jobs[0]
	m.snapshot.Jobs = nil
	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{{Id: "pr", Url: "https://github.com/owner/repo/pull/1"}}}
	m.ensureSelection()
	m.Resize(layout.Size{Width: 132, Height: 40})

	view := ansi.Strip(m.View())
	if !strings.Contains(view, "PULL REQUESTS") || strings.Contains(view, "DEMOS") || strings.Contains(view, "/ JOBS") {
		t.Fatal("PR-only sidebar advertises unrelated tasks")
	}

	m.snapshot.Jobs = append(m.snapshot.Jobs, job)
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if !strings.Contains(ansi.Strip(m.View()), "PULL REQUESTS / JOBS") {
		t.Fatal("a local fixture was mislabeled as a pull request")
	}
}

func TestArchivedMonitoringRetainsDeadlineWarning(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Jobs = nil
	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{{Id: "archived", Url: "https://github.com/owner/repo/pull/1", Enabled: true, TrackingState: v1.TrackingState_TRACKING_STATE_ARCHIVED, ArchiveReason: new("deadline")}}}
	m.ensureSelection()
	view := ansi.Strip(m.trackingContent())

	for _, want := range []string{"Monitoring:", "archived", "check results remain incomplete"} {
		if !strings.Contains(view, want) {
			t.Errorf("missing retirement presentation %q", want)
		}
	}
}
