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

	visible := strings.Join(strings.Fields(ansi.Strip(raw)), " ")
	for _, want := range []string{"owner/repo#42", "owner/repo@aaaaaaaa", "Notification accepted", "Retry", "policy", "unverified"} {
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

	view := strings.Join(strings.Fields(ansi.Strip(m.activityContent())), " ")
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
		for _, destination := range []string{prURL, "https://github.com/owner/repo/compare/" + base + ".." + head, "https://github.com/owner/repo/compare/" + target + ".." + head} {
			if !strings.Contains(content, ansi.SetHyperlink(destination)) {
				t.Errorf("width %d lost target %q", width, destination)
			}
		}

		for _, role := range []string{"bbbbbbbb..aaaaaaaa", "cccccccc..aaaaaaaa"} {
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

	for _, want := range []string{"Code review from reviewer", "src/parser.ts:42", "Please reuse the existing parser.", "Feedback", "Partial"} {
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

	if !strings.Contains(pending, "waiting") || !strings.Contains(pending, "Partial") || strings.Contains(pending, "Workflow still queued") || strings.Contains(pending, "opaque-watch-id") {
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

func TestTrackingRendersReviewMarkdownAndStatusLayout(t *testing.T) {
	t.Parallel()

	for _, mode := range []theme.Mode{theme.Dark, theme.Light, theme.Contrast, theme.Mono} {
		m := model(t, mode)
		m.snapshot.Jobs = nil
		m.snapshot.Tracking = &v1.TrackingSnapshot{
			Prs: []*v1.TrackedPullRequest{{Id: "pr", Url: "https://github.com/owner/repo/pull/42", Enabled: true, Observation: &v1.TrackingObservation{
				ChecksJson: `{"state":"partial","reason":"Repeated coverage explanation"}`, ReviewsJson: `{"state":"complete"}`, FeedbackJson: new(`{"state":"unavailable","reason":"API unavailable"}`),
			}}},
			Actions: []*v1.PendingAction{{Id: "review", PrId: "pr", Summary: "Review feedback", State: v1.ActionState_ACTION_STATE_OPEN, Blocker: &v1.PendingAction_ReviewFeedback{ReviewFeedback: &v1.ReviewFeedback{
				Body: "<!-- bot metadata -->\n\n### Review heading\n\n**Keep this prose** and `parser.ts`.\n\n```go\nreturn result\n```\n\n<details>\n<summary>Review details</summary>\n\nAdditional review evidence.\n\n</details>\n\n\x1b[2JVisible text",
			}}}},
		}
		m.ensureSelection()
		m.Resize(layout.Size{Width: 208, Height: 111})

		content := ansi.Strip(m.result.View())
		for _, want := range []string{"Review heading", "Keep this prose", "parser.ts", "return result", "Additional review evidence", "Visible text"} {
			if !strings.Contains(content, want) {
				t.Errorf("missing review content %q in %q", want, content)
			}
		}

		for _, raw := range []string{"### Review heading", "**Keep this prose**", "```", "<!--", "<details>", "<summary>", "\x1b[2J", "Repeated coverage explanation"} {
			if strings.Contains(ansi.Strip(m.result.View()), raw) {
				t.Errorf("raw prose rendered %q", raw)
			}
		}

		statusFound := false

		for _, line := range strings.Split(content, "\n") {
			if strings.Contains(line, "Checks") && strings.Contains(line, "Reviews") && strings.Contains(line, "Feedback") {
				statusFound = true
			}
		}

		if !statusFound {
			t.Error("coverage fields do not share one status row")
		}

		for _, size := range []layout.Size{{Width: 80, Height: 32}, {Width: 40, Height: 16}} {
			m.Resize(size)

			for _, line := range strings.Split(m.View(), "\n") {
				if ansi.StringWidth(line) > size.Width {
					t.Fatal("review Markdown exceeds terminal width")
				}
			}
		}
	}
}

func TestCoveragePillsKeepPartialAndUnavailableDistinct(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)

	cases := []struct {
		raw, label string
		tone       text.Tone
	}{
		{`{"state":"complete"}`, "Complete", text.Success},
		{`{"state":"partial","reason":"Long repeated sentence"}`, "Partial", text.Warning},
		{`{"state":"unavailable","reason":"Network failed"}`, "Unavailable", text.Danger},
		{`invalid`, "Unavailable", text.Danger},
		{`{"state":"new-provider-state"}`, "Unknown", text.Neutral},
	}
	for _, c := range cases {
		if got := m.coveragePill(c.raw); got != text.Pill(c.label, c.tone, m.theme, text.Normal) {
			t.Errorf("coverage %s did not retain its labeled semantic pill", c.raw)
		}
	}
}

func TestCheckWatchPanelKeepsCurrentRevisionVisibleAndScrollsIndependently(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Jobs = nil
	pr := &v1.TrackedPullRequest{Id: "pr", Url: "https://github.com/owner/repo/pull/42", Enabled: true}

	m.snapshot.Tracking = &v1.TrackingSnapshot{Prs: []*v1.TrackedPullRequest{pr}}
	for i := range 12 {
		m.snapshot.Tracking.CheckWatches = append(m.snapshot.Tracking.CheckWatches, &v1.CheckWatch{PrId: "pr", HeadSha: strings.Repeat("a", 40), CreatedAtMs: int64(i), State: v1.CheckWatchState_CHECK_WATCH_STATE_SUPERSEDED, EvidenceJson: `{"state":"partial","reason":"Repeated explanation"}`})
	}

	m.snapshot.Tracking.CheckWatches = append(m.snapshot.Tracking.CheckWatches, &v1.CheckWatch{PrId: "pr", HeadSha: strings.Repeat("b", 40), CreatedAtMs: 13, State: v1.CheckWatchState_CHECK_WATCH_STATE_WAITING, EvidenceJson: `{"state":"partial"}`})
	m.ensureSelection()
	m.Resize(layout.Size{Width: 208, Height: 40})

	if !strings.Contains(ansi.Strip(m.activity.View()), "bbbbbbbb") || !strings.Contains(ansi.Strip(m.View()), "CHECK WATCHES") {
		t.Fatal("current watch hidden behind superseded history")
	}

	if strings.Contains(ansi.Strip(m.result.View()), "bbbbbbbb") {
		t.Fatal("watches duplicated in main tracking panel")
	}

	m.key(tea.KeyPressMsg{Code: tea.KeyTab})
	m.key(tea.KeyPressMsg{Code: ']', Text: "]"})

	if m.activity.YOffset() == 0 || m.result.YOffset() != 0 {
		t.Fatal("check-watch panel did not scroll independently")
	}

	other := &v1.TrackedPullRequest{Id: "other", Url: "https://github.com/owner/repo/pull/43", Enabled: true}

	m.snapshot.Tracking.Prs = append(m.snapshot.Tracking.Prs, other)
	for i := range 12 {
		m.snapshot.Tracking.CheckWatches = append(m.snapshot.Tracking.CheckWatches, &v1.CheckWatch{PrId: "other", HeadSha: strings.Repeat("c", 40), CreatedAtMs: int64(i), EvidenceJson: `{"state":"partial"}`})
	}

	m.key(tea.KeyPressMsg{Code: 'j', Text: "j"})

	if m.activity.YOffset() != 0 || !strings.Contains(ansi.Strip(m.activity.View()), "cccccccc") {
		t.Fatal("PR selection retained another PR's watch offset")
	}

	m.key(tea.KeyPressMsg{Code: ']', Text: "]"})
	scrolled := m.activity.YOffset()
	m.resizeContent()

	if scrolled == 0 || m.activity.YOffset() != scrolled {
		t.Fatal("same-PR refresh lost watch scroll position")
	}

	m.key(tea.KeyPressMsg{Code: 'k', Text: "k"})

	if m.activity.YOffset() != 0 || !strings.Contains(ansi.Strip(m.activity.View()), "bbbbbbbb") {
		t.Fatal("returning to a PR hid its current watch")
	}

	m.key(tea.KeyPressMsg{Code: ']', Text: "]"})
	m.key(tea.KeyPressMsg{Code: '2', Text: "2"})
	m.key(tea.KeyPressMsg{Code: '4', Text: "4"})

	if m.activity.YOffset() != 0 || !strings.Contains(ansi.Strip(m.activity.View()), "bbbbbbbb") {
		t.Fatal("entering tracking retained the worker pane's offset")
	}

	m.snapshot.Jobs = []*v1.Job{
		{Id: "run1", Task: &v1.Task{Kind: &v1.Task_SummarizePullRequest{SummarizePullRequest: &v1.SummarizePullRequestTask{Url: pr.GetUrl()}}}},
		{Id: "run2", Task: &v1.Task{Kind: &v1.Task_SummarizePullRequest{SummarizePullRequest: &v1.SummarizePullRequestTask{Url: pr.GetUrl()}}}},
	}
	m.selected = "run1"
	m.resizeContent()
	m.key(tea.KeyPressMsg{Code: ']', Text: "]"})
	scrolled = m.activity.YOffset()
	m.key(tea.KeyPressMsg{Code: 'l', Text: "l"})

	if m.selected != "run1" || m.activity.YOffset() != scrolled {
		t.Fatal("tracking navigation changed the selected run or check-watch scroll")
	}

	m.key(tea.KeyPressMsg{Code: 'h', Text: "h"})

	if m.selected != "run1" || m.activity.YOffset() != scrolled {
		t.Fatal("tracking navigation changed the selected run or check-watch scroll")
	}

	m.Resize(layout.Size{Width: 40, Height: 16})

	if m.focus.Current() != "result" || !strings.Contains(ansi.Strip(m.trackingContent()), "bbbbbbbb") {
		t.Fatal("small terminal lost check watches or kept invisible focus")
	}
}
