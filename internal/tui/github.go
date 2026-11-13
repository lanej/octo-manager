package tui

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/NimbleMarkets/ntcharts/v2/linechart/timeserieslinechart"
	"github.com/lanej/charmed/chart"
	"github.com/lanej/charmed/feedback"
	"github.com/lanej/charmed/layout"
	"github.com/lanej/charmed/text"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

func (m *Model) globalPanel() bool {
	return m.panel == activityPanel || m.panel == githubPanel
}

func (m *Model) githubSummary() string {
	budget := m.snapshot.GetGithubUsage().GetRest()
	if budget == nil || budget.GetLimit() == 0 {
		return "6 GitHub usage"
	}

	if budget.GetResetAtMs() <= m.snapshot.GetGithubUsage().GetSampledAtMs() {
		return "REST awaiting quota · 6 usage"
	}

	return fmt.Sprintf("REST %d/%d observed · 6 usage", budget.GetRemaining(), budget.GetLimit())
}

func (m *Model) budgetView(label string, budget *v1.GitHubRateBudget, retryAt, sampledAt int64, width int) string {
	title := text.Badge(label, m.theme)
	if retryAt > sampledAt {
		title += " " + text.Pill("reads paused", text.Warning, m.theme, text.Normal) +
			"\n" + m.field("Retry after", m.timestamp(retryAt, fullTimestamp))
	}

	if budget == nil || budget.GetLimit() == 0 || budget.GetRemaining() > budget.GetLimit() {
		return title + "\n" + m.muted("Quota not observed yet.")
	}

	remaining := float64(budget.GetRemaining()) / float64(budget.GetLimit())
	percent := remaining * 100
	bar := feedback.NewProgress(max(1, min(48, width)), m.theme)

	value := fmt.Sprintf("%d / %d remaining · %.1f%%", budget.GetRemaining(), budget.GetLimit(), percent)
	if budget.GetResetAtMs() <= sampledAt {
		return title + "\n" + m.field("Last quota observation", value) +
			"\n" + m.muted("Reset time passed; waiting for new quota evidence.") +
			"\n" + m.field("Observed", m.timestamp(budget.GetObservedAtMs(), fullTimestamp))
	}

	return title + "\n" + text.Label(value, m.theme) + "\n" + bar.ViewAs(remaining) +
		"\n" + m.field("Resets", m.timestamp(budget.GetResetAtMs(), fullTimestamp)) +
		"\n" + m.field("Observed", m.timestamp(budget.GetObservedAtMs(), fullTimestamp))
}

func requestSeries(minutes []*v1.GitHubReadMinute) ([]chart.TimeSeriesData, float64) {
	series := []chart.TimeSeriesData{
		{ID: "rest", Label: "REST attempts", Unit: "/min"},
		{ID: "graphql", Label: "GraphQL attempts", Unit: "/min"},
		{ID: "cache", Label: "Cache reuses", Unit: "/min"},
	}
	peak := 1.0

	for _, minute := range minutes {
		counts := [3]uint64{minute.GetRest(), minute.GetGraphql(), minute.GetCacheReuses()}
		for i, count := range counts {
			value := float64(count)
			peak = math.Max(peak, value)
			series[i].Points = append(series[i].Points, timeserieslinechart.TimePoint{
				Time: time.UnixMilli(minute.GetStartedAtMs()), Value: value,
			})
		}
	}

	return series, peak
}

func (m *Model) githubContent(width int) string {
	usage := m.snapshot.GetGithubUsage()
	if usage == nil {
		return text.Badge("GitHub usage", m.theme) + "\n" + m.muted("Usage metrics unavailable from this coordinator.")
	}

	lines := []string{
		text.Badge("GitHub quota remaining", m.theme),
		m.muted("Shared authentication budget · includes other tools · GraphQL uses points"),
		m.budgetView("REST", usage.GetRest(), usage.GetRestRetryAtMs(), usage.GetSampledAtMs(), width),
		"",
		m.budgetView("GraphQL", usage.GetGraphql(), usage.GetGraphqlRetryAtMs(), usage.GetSampledAtMs(), width),
		"",
		text.Badge("Octo read traffic", m.theme),
		m.field("Since coordinator started", fmt.Sprintf("%d attempts · %d cache reuses · %d rate-limit responses",
			usage.GetRequests(), usage.GetCacheReuses(), usage.GetRateLimits())),
		m.field("Started", m.timestamp(usage.GetStartedAtMs(), fullTimestamp)),
		m.muted("Rolling hour · per-minute counts · current minute is partial · resets on restart"),
	}

	minutes := usage.GetMinutes()
	if len(minutes) == 0 {
		return strings.Join(append(lines, m.muted("Traffic history not observed yet.")), "\n")
	}

	series, peak := requestSeries(minutes)
	first := time.UnixMilli(minutes[0].GetStartedAtMs())
	last := time.UnixMilli(minutes[len(minutes)-1].GetStartedAtMs()).Add(time.Minute)
	plot := chart.NewTimeSeries(series, layout.Size{Width: max(1, width), Height: 9}, m.theme,
		timeserieslinechart.WithYRange(0, peak),
		timeserieslinechart.WithTimeRange(first, last),
		timeserieslinechart.WithXLabelFormatter(func(_ int, value float64) string {
			return time.Unix(int64(math.Round(value)), 0).In(m.location).Format("15:04")
		}),
	)
	lines = append(lines, plot.View(), chart.SeriesLegend(series, max(1, width), m.theme),
		m.muted("Chart times: "+m.zoneLabel()+" · read attempts include transport failures; Git pushes and writes are excluded."),
		m.field("Metrics sampled", m.timestamp(usage.GetSampledAtMs(), fullTimestamp)))

	return strings.Join(lines, "\n")
}
