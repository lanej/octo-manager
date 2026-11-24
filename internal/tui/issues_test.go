package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/theme"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func TestIssuesDashboardShowsLifecycleAndBrief(t *testing.T) {
	t.Parallel()
	m := model(t, theme.Dark)
	m.snapshot.Issues = []*v1.ManagedIssue{{Id: "first", Reference: &v1.IssueReference{Provider: "github", Project: "owner/repo", ExternalId: "12", Url: "https://github.com/owner/repo/issues/12"}, Title: "Correct answer", Stage: v1.IssueStage_ISSUE_STAGE_INVESTIGATION, Waiting: v1.IssueWaiting_ISSUE_WAITING_NEEDS_CLARIFICATION, Detail: "Confirm compatibility", Brief: &v1.IssueBrief{Version: 2, Outcome: "Return 42", Scope: "One function", Criteria: []string{"answer() returns 42"}, Questions: []string{"Keep compatibility?"}}}, {Id: "second", Reference: &v1.IssueReference{Url: "https://github.com/owner/repo/issues/13"}, Title: "Second issue", Stage: v1.IssueStage_ISSUE_STAGE_TESTING}}
	m.key(tea.KeyPressMsg{Code: '6'})
	m.Resize(layout.Size{Width: 120, Height: 36})

	rendered := ansi.Strip(m.View())
	for _, want := range []string{"ISSUE LIFECYCLE", "Correct answer", "Confirm compatibility", "Return 42", "Keep compatibility?"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("missing %q in rendered issues view:\n%s", want, rendered)
		}
	}

	m.key(tea.KeyPressMsg{Code: 'l'})

	if m.issueIndex != 1 {
		t.Fatal("next issue selection did not advance")
	}

	m.key(tea.KeyPressMsg{Code: 'h'})

	if m.issueIndex != 0 {
		t.Fatal("previous issue selection did not return")
	}
}
