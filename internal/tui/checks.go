package tui

import (
	"sort"
	"strings"

	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v2"
)

func (m *Model) checkWatchContent(pr *v1.TrackedPullRequest) string {
	watches := append([]*v1.CheckWatch(nil), m.snapshot.GetTracking().GetCheckWatches()...)
	sort.SliceStable(watches, func(i, j int) bool { return watches[i].GetCreatedAtMs() > watches[j].GetCreatedAtMs() })

	var parts []string

	for _, watch := range watches {
		if watch.GetPrId() != pr.GetId() {
			continue
		}

		state := stateName(watch.GetState().String(), "CHECK_WATCH_STATE_")
		status := text.Pill(state, text.Neutral, m.theme, text.Normal)
		commit := m.commitLink(pr.GetUrl(), watch.GetHeadSha())
		coverage := m.field("Check coverage", observationStatus(watch.GetEvidence()))

		parts = append(parts, status+" "+commit+" · "+coverage)
	}

	if len(parts) == 0 {
		return ""
	}

	return strings.Join(parts, "\n")
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
