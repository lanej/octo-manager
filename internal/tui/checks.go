package tui

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func (m *Model) checkWatchContent(pr *v1.TrackedPullRequest) string {
	if pr == nil {
		return "No tracked PR selected."
	}

	var parts []string

	watches := append([]*v1.CheckWatch(nil), m.snapshot.GetTracking().GetCheckWatches()...)
	sort.SliceStable(watches, func(i, j int) bool { return watches[i].GetCreatedAtMs() > watches[j].GetCreatedAtMs() })

	for _, watch := range watches {
		if watch.GetPrId() != pr.GetId() {
			continue
		}

		parts = append(parts, text.Pill(stateName(watch.GetState().String(), "CHECK_WATCH_STATE_"), text.Neutral, m.theme, text.Normal)+" "+m.commitLink(pr.GetUrl(), watch.GetHeadSha())+"  "+m.coveragePill(watch.GetEvidenceJson()))
	}

	if len(parts) == 0 {
		return m.muted("No check watches yet.")
	}

	return strings.Join(parts, "\n")
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

func (m *Model) coveragePill(raw string) string {
	var value struct{ State string }
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return text.Pill("Unavailable", text.Danger, m.theme, text.Normal)
	}

	label, tone := "Unknown", text.Neutral

	switch value.State {
	case "complete":
		label, tone = "Complete", text.Success
	case "partial":
		label, tone = "Partial", text.Warning
	case "unavailable":
		label, tone = "Unavailable", text.Danger
	}

	return text.Pill(label, tone, m.theme, text.Normal)
}
