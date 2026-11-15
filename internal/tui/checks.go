package tui

import (
	"strings"

	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func (m *Model) checkWatchContent(pr *v1.TrackedPullRequest) string {
	var parts []string

	for _, watch := range m.snapshot.GetTracking().GetCheckWatches() {
		if watch.GetPrId() != pr.GetId() {
			continue
		}

		parts = append(parts, text.Pill(stateName(watch.GetState().String(), "CHECK_WATCH_STATE_"), text.Neutral, m.theme, text.Normal)+" "+m.commitLink(pr.GetUrl(), watch.GetHeadSha()), m.field("Check coverage", observationStatus(watch.GetEvidence())))
	}

	if len(parts) == 0 {
		return ""
	}

	return text.Badge("Check watches", m.theme) + "\n" + strings.Join(parts, "\n")
}

func (m *Model) checkResultsContent(result *v1.CheckResults, pr *v1.TrackedPullRequest) string {
	parts := []string{m.muted("Checked head: ") + m.commitLink(pr.GetUrl(), result.GetHeadSha())}
	if result.GetReplacementHeadSha() != "" {
		parts = append(parts, m.muted("New head: ")+m.commitLink(pr.GetUrl(), result.GetReplacementHeadSha()))
	}

	for _, check := range result.GetChecks() {
		parts = append(parts, text.Label(safe(check.GetName()), m.theme)+" · "+text.Label(safe(check.GetConclusion()), m.theme)+" "+m.link(check.GetUrl()))
	}

	return strings.Join(parts, "\n")
}
