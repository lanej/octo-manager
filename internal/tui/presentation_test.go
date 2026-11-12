package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
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
	for _, want := range []string{"owner/repo#42", "owner/repo@aaaaaaaa", "Notification accepted", "Failed check: Retry policy", "agent receipt and acknowledgment are unverified"} {
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

func TestCharmedTrackingLinksKeepTargetsAcrossResize(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	prURL := "https://github.com/owner/repo/pull/42"
	head, base, target := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40)
	pr := &v1.TrackedPullRequest{Url: prURL, Observation: &v1.TrackingObservation{HeadSha: head, BaseSha: base, TargetBase: &v1.TargetBase{Ref: "main", Sha: target}}}

	for _, width := range []int{132, 80, 40} {
		m.Resize(layout.Size{Width: width, Height: 40})

		content := m.trackingLinks(pr)
		for _, destination := range []string{prURL, "https://github.com/owner/repo/commit/" + head, "https://github.com/owner/repo/commit/" + base, "https://github.com/owner/repo/commit/" + target} {
			if !strings.Contains(content, ansi.SetHyperlink(destination)) {
				t.Errorf("width %d lost target %q", width, destination)
			}
		}

		for _, role := range []string{"Head:", "PR-reported base:", "Target main:"} {
			if !strings.Contains(ansi.Strip(content), role) {
				t.Errorf("width %d lost role %q", width, role)
			}
		}

		g := m.geometry()

		inner := layout.PanelContentSize(layout.Size{Width: g.right, Height: g.result})
		for _, line := range strings.Split(content, "\n") {
			if ansi.StringWidth(line) > inner.Width-1 {
				t.Fatalf("group exceeds its %d-cell panel", inner.Width-1)
			}
		}
	}

	address := "https://example.org/%7Epath?q=%2f#part"
	if !strings.Contains(m.link(address), ansi.SetHyperlink(address)) {
		t.Fatal("link changed the exact destination")
	}

	for _, address := range []string{"http://example.org/", "https://user@example.org/", "https://example.org/\npath", "https://example.org/?bad=%zz"} {
		if strings.Contains(m.link(address), "\x1b]8;") {
			t.Errorf("unsafe destination was linked: %q", address)
		}
	}
}

func TestTrackingPresentsReviewFeedbackAndLocation(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	pr := &v1.TrackedPullRequest{Id: "feedback-pr", Url: "https://github.com/owner/repo/pull/42", Enabled: true, Observation: &v1.TrackingObservation{FeedbackJson: new(`{"state":"partial","reason":"Comments unavailable"}`)}}
	m.snapshot.Tracking = &v1.TrackingSnapshot{
		Prs: []*v1.TrackedPullRequest{pr},
		Actions: []*v1.PendingAction{{
			Id: "feedback-action", PrId: pr.GetId(), Summary: "Code review from reviewer", State: v1.ActionState_ACTION_STATE_OPEN,
			Blocker:     &v1.PendingAction_ReviewFeedback{ReviewFeedback: &v1.ReviewFeedback{Source: "inline", Author: "reviewer", Body: "Please reuse the existing parser.", Path: new("src/parser.ts"), Line: new(uint32(42)), Url: "https://github.com/owner/repo/pull/42#discussion_r1"}},
			EvidenceUrl: "https://github.com/owner/repo/pull/42#discussion_r1",
		}},
	}
	m.selected = ""
	m.ensureSelection()
	view := ansi.Strip(m.trackingContent())

	for _, want := range []string{"Code review from reviewer", "src/parser.ts:42", "Please reuse the existing parser.", "Feedback:", "Comments unavailable"} {
		if !strings.Contains(view, want) {
			t.Errorf("feedback missing %q", want)
		}
	}
}

func TestTrackingDistinguishesMessageReceiptFromTransportAdmission(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	delivery := &v1.ActionDelivery{Id: "message", ActionId: "action", State: v1.DeliveryState_DELIVERY_STATE_DELIVERED, MessageSequence: new(uint64(1))}
	m.snapshot.Tracking = &v1.TrackingSnapshot{
		Prs:        []*v1.TrackedPullRequest{{Id: "pr", Url: "https://github.com/owner/repo/pull/42", Enabled: true}},
		Actions:    []*v1.PendingAction{{Id: "action", PrId: "pr", Summary: "Review feedback", State: v1.ActionState_ACTION_STATE_OPEN}},
		Deliveries: []*v1.ActionDelivery{delivery},
	}
	m.selected = ""
	m.ensureSelection()

	if !strings.Contains(ansi.Strip(m.trackingContent()), "Awaiting agent receipt") {
		t.Fatal("queue admission was presented as recipient receipt")
	}

	delivery.AcknowledgedAtMs = new(int64(1000))
	view := ansi.Strip(m.trackingContent())

	if !strings.Contains(view, "Agent received") || strings.Contains(view, "Awaiting agent receipt") {
		t.Fatal("message-specific receipt was not presented")
	}
}

func TestCheckWatchPresentsPendingCoverageAndLinkedResults(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	pr := &v1.TrackedPullRequest{Id: "pr", Url: "https://github.com/owner/repo/pull/42", Enabled: true}
	sha := strings.Repeat("a", 40)
	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{pr}, CheckWatches: []*v1.CheckWatch{{Id: "opaque-watch-id", PrId: "pr", HeadSha: sha, State: v1.CheckWatchState_CHECK_WATCH_STATE_WAITING, EvidenceJson: `{"state":"partial","reason":"Workflow still queued"}`}}}
	pending := ansi.Strip(m.checkWatchContent(pr))

	if !strings.Contains(pending, "waiting") || !strings.Contains(pending, "Workflow still queued") || strings.Contains(pending, "opaque-watch-id") {
		t.Fatal("check watch did not present human-readable pending state")
	}

	result := m.checkResultsContent(&v1.CheckResults{HeadSha: sha, State: v1.CheckWatchState_CHECK_WATCH_STATE_COMPLETED, ChecksJson: `[{"name":"Linux checks","conclusion":"success","url":"https://github.com/owner/repo/actions/runs/123"}]`}, pr)
	if !strings.Contains(ansi.Strip(result), "Linux checks") || !strings.Contains(ansi.Strip(result), "success") {
		t.Fatal("check completion lost its individual conclusions")
	}

	if !strings.Contains(result, ansi.SetHyperlink("https://github.com/owner/repo/commit/"+sha)) || !strings.Contains(result, ansi.SetHyperlink("https://github.com/owner/repo/actions/runs/123")) {
		t.Fatal("check completion lost its commit or run link")
	}
}
