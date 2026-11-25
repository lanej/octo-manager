package tui

import (
	"fmt"
	"strings"
)

func (m *Model) issuesContent() string {
	issues := m.snapshot.GetIssues()
	if len(issues) == 0 {
		return "No managed issues. Enroll one with octo-manager issue track ISSUE_URL."
	}

	lines := []string{}

	for index, issue := range issues {
		prefix := "  "
		if index == m.issueIndex {
			prefix = "> "
		}

		lines = append(lines, prefix+m.link(issue.GetReference().GetUrl())+" · "+safe(issue.GetTitle())+" · "+stateName(issue.GetStage().String(), "ISSUE_STAGE_")+" · "+stateName(issue.GetWaiting().String(), "ISSUE_WAITING_"))
	}

	issue := issues[min(m.issueIndex, len(issues)-1)]

	lines = append(lines, "", m.field("Next", issue.GetDetail()), m.field("Workspace", issue.GetWorkspace()))
	if assignment := issue.GetAssignment(); assignment != nil {
		lines = append(lines, m.field("Agent", assignment.GetRole()+" · "+assignment.GetState()+" · "+assignment.GetModel()))
	}

	if issue.GetPrUrl() != "" {
		lines = append(lines, "PR: "+m.link(issue.GetPrUrl()))
	}

	if brief := issue.GetBrief(); brief != nil {
		lines = append(lines, "", fmt.Sprintf("Brief %d · approved %d", brief.GetVersion(), issue.GetApprovedVersion()), safe(brief.GetOutcome()), m.field("Scope", brief.GetScope()), "Acceptance criteria:")
		for _, item := range brief.GetCriteria() {
			lines = append(lines, "  "+safe(item))
		}

		if len(brief.GetQuestions()) > 0 {
			lines = append(lines, "Clarification:")
			for _, item := range brief.GetQuestions() {
				lines = append(lines, "  "+safe(item))
			}
		}

		if len(brief.GetAssumptions()) > 0 {
			lines = append(lines, "Assumptions:")
			for _, item := range brief.GetAssumptions() {
				lines = append(lines, "  "+safe(item))
			}
		}
	}

	return strings.Join(lines, "\n")
}
