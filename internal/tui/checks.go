package tui

import (
	"encoding/json"
	"strings"

	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func (m *Model) checkWatchContent(pr *v1.TrackedPullRequest) string {
	var parts []string

	for _, watch := range m.snapshot.GetTracking().GetCheckWatches() {
		if watch.GetPrId() != pr.GetId() {
			continue
		}

		parts = append(parts, text.Pill(stateName(watch.GetState().String(), "CHECK_WATCH_STATE_"), text.Neutral, m.theme, text.Normal)+" "+m.commitLink(pr.GetUrl(), watch.GetHeadSha()), m.field("Check coverage", observationStatus(watch.GetEvidenceJson())))
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

	var checks []struct{ Name, Status, Conclusion, URL string }

	if err := json.Unmarshal([]byte(result.GetChecksJson()), &checks); err != nil {
		return strings.Join(append(parts, m.muted("Check details unavailable.")), "\n")
	}

	for _, check := range checks {
		parts = append(parts, text.Label(safe(check.Name), m.theme)+" · "+text.Label(safe(check.Conclusion), m.theme)+" "+m.link(check.URL))
	}

	return strings.Join(parts, "\n")
}
