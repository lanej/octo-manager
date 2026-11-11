package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func TestSessionContextIsShortAndRecognizable(t *testing.T) {
	t.Parallel()

	cases := []struct{ label, cwd, id, want string }{
		{"Fix blocker tracking", "/Users/joshlane/src/octo-manager", "01a1c358-7438-7c03-beaf-63e133fc5950", "Fix blocker tracking"},
		{"", "/Users/joshlane/src/octo-manager", "opaque", "…/src/octo-manager"},
		{"/Users/joshlane/src/octo-manager", "", "opaque", "…/src/octo-manager"},
		{"", "", "01a1c358-7438-7c03-beaf-63e133fc5950", "session 01a1c358"},
		{"", "/", "opaque", "/"},
		{"", "", "", "Unknown session"},
	}
	for _, c := range cases {
		if got := sessionContext(c.label, c.cwd, c.id); got != c.want {
			t.Errorf("session context = %q, want %q", got, c.want)
		}
	}

	if got := sessionContext(strings.Repeat("界", 80), "", "opaque"); ansi.StringWidth(got) > 48 {
		t.Fatal("topic exceeds its display bound")
	}
}

func TestActivityPresentsPRsCommitsAndActionsInsteadOfDatabaseKeys(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	prID, actionID, deliveryID := "pr-internal-uuid", "action-internal-uuid", "delivery-internal-uuid"
	sha := strings.Repeat("a", 40)
	m.snapshot.Tracking = &v1.TrackingSnapshot{
		Prs:     []*v1.TrackedPullRequest{{Id: prID, Url: "https://github.com/owner/repo/pull/42"}},
		Actions: []*v1.PendingAction{{Id: actionID, PrId: prID, Summary: "Failed check: Retry policy"}},
	}
	m.agentActivity.events = []*v1.JobEvent{
		{Sequence: 1, Kind: "pr_observed", PrId: &prID, Detail: "Observed head " + sha},
		{Sequence: 2, Kind: "pr_observed", PrId: &prID, Detail: "Observed head " + sha},
		{Sequence: 3, Kind: "delivery_delivered", PrId: &prID, ActionId: &actionID, Detail: deliveryID},
	}
	raw := m.activityContent()

	visible := ansi.Strip(raw)
	for _, want := range []string{"owner/repo#42", "owner/repo@aaaaaaaa", "Notification accepted", "Failed check: Retry policy", "acknowledgment and resolution are still separate"} {
		if !strings.Contains(visible, want) {
			t.Errorf("missing readable context %q", want)
		}
	}

	for _, hidden := range []string{prID, actionID, deliveryID, sha, "#3", "Operation:"} {
		if strings.Contains(visible, hidden) {
			t.Errorf("database metadata leaked into UI: %q", hidden)
		}
	}

	if strings.Count(visible, "PR checked") != 1 {
		t.Fatal("unchanged polling obscures meaningful activity")
	}

	if !strings.Contains(raw, ansi.SetHyperlink("https://github.com/owner/repo/commit/"+sha)) || !strings.Contains(raw, ansi.SetHyperlink("https://github.com/owner/repo/pull/42")) {
		t.Fatal("readable references lost their GitHub destinations")
	}

	m.agentActivity.events = append(m.agentActivity.events, &v1.JobEvent{Sequence: 4, Kind: "pr_observed", PrId: &prID, Detail: "Observed head " + strings.Repeat("b", 40)})
	if strings.Count(ansi.Strip(m.activityContent()), "PR checked") != 2 {
		t.Fatal("a changed commit disappeared with duplicate polling")
	}
}

func TestPresentationDoesNotInventMissingHistoryOrUnsafeLinks(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	id := "unknown-private-database-key"
	m.agentActivity.events = []*v1.JobEvent{{Kind: "pr_observed", PrId: &id, Detail: "Observed head " + strings.Repeat("a", 40)}}

	view := ansi.Strip(m.activityContent())
	if !strings.Contains(view, "PR context unavailable") || strings.Contains(view, id) {
		t.Fatal("missing context was exposed as an internal key")
	}

	if strings.Contains(m.link("javascript:alert(1)"), ansi.SetHyperlink("javascript:alert(1)")) {
		t.Fatal("unsafe link was made clickable")
	}
}

func TestLinksSanitizeDecodedLabelsAndUnchangedSnapshotsKeepCachedActivity(t *testing.T) {
	t.Parallel()

	m := model(t, theme.Dark)
	for _, address := range []string{"https://github.com/owner/%1B%5B31m/actions/runs/1", "https://github.com/%1B%5B31m/repo/commit/" + strings.Repeat("a", 40)} {
		if strings.Contains(m.link(address), "\x1b[31m") {
			t.Fatal("decoded URL injected terminal control into its label")
		}
	}

	m.panel = activityPanel
	m.instance = "fixture"
	m.snapshot.InstanceId = "fixture"
	m.snapshot.Sequence = 1
	m.agentActivity = activityHistory{instance: "fixture", seenThrough: 1}
	m.activityRender = activityRenderCache{valid: true, source: "cached activity marker", width: -1}
	m.Update(snapshotMsg{snapshot: m.snapshot})

	if m.activityRender.source != "cached activity marker" {
		t.Fatal("unchanged periodic snapshot rebuilt cached history")
	}

	changed := &v1.Snapshot{InstanceId: "fixture", Sequence: 2}
	m.Update(snapshotMsg{snapshot: changed})

	if m.activityRender.source == "cached activity marker" {
		t.Fatal("new reference context did not invalidate cached presentation")
	}
}
