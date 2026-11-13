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
	for _, budget := range []*v1.GitHubRateBudget{m.snapshot.GetGithubUsage().GetRest(), m.snapshot.GetGithubUsage().GetGraphql()} {
		if budget.GetForecast().GetState() == v1.GitHubForecastState_GIT_HUB_FORECAST_STATE_AT_RISK {
			return "GitHub forecast: limit before reset · 6 usage"
		}
	}

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
		"\n" + m.field("Observed", m.timestamp(budget.GetObservedAtMs(), fullTimestamp)) + "\n" + m.forecastView(label, budget.GetForecast())
}

func (m *Model) forecastView(label string, forecast *v1.GitHubQuotaForecast) string {
	if forecast == nil {
		return m.field("Forecast", "Unavailable from this coordinator")
	}

	units := "requests"
	if label == "GraphQL" {
		units = "points"
	}

	var status string

	switch forecast.GetState() {
	case v1.GitHubForecastState_GIT_HUB_FORECAST_STATE_UNSPECIFIED, v1.GitHubForecastState_GIT_HUB_FORECAST_STATE_UNKNOWN:
		return m.field("Forecast", m.muted(safe(forecast.GetReason())))
	case v1.GitHubForecastState_GIT_HUB_FORECAST_STATE_ON_TRACK:
		status = text.Pill("On track", text.Success, m.theme, text.Normal) + fmt.Sprintf(" · %.0f %s projected remaining at reset", forecast.GetProjectedRemainingAtReset(), units)
	case v1.GitHubForecastState_GIT_HUB_FORECAST_STATE_AT_RISK:
		status = text.Pill("Limit before reset", text.Warning, m.theme, text.Normal) + " · estimated exhaustion " + m.timestamp(forecast.GetExhaustAtMs(), fullTimestamp)
	case v1.GitHubForecastState_GIT_HUB_FORECAST_STATE_EXHAUSTED:
		status = text.Pill("Quota exhausted", text.Warning, m.theme, text.Normal)
	default:
		return m.field("Forecast", m.muted("Unknown forecast state"))
	}

	if forecast.UnitsPerHour == nil {
		return m.field("Forecast", status)
	}

	return m.field("Forecast", status) + "\n" + m.muted(fmt.Sprintf("Recent pace: %.0f %s/hour over %.1f min · estimate, not a guarantee", forecast.GetUnitsPerHour(), units, float64(forecast.GetWindowMs())/60000))
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

	scheduler := m.schedulerContent()
	budgets := m.sections("github-quota-comparison", width,
		dashboardSection{id: "rest-budget", title: "REST QUOTA", content: func(w int) string {
			return m.budgetView("REST", usage.GetRest(), usage.GetRestRetryAtMs(), usage.GetSampledAtMs(), w)
		}},
		dashboardSection{id: "graphql-budget", title: "GRAPHQL QUOTA", content: func(w int) string {
			return m.budgetView("GraphQL", usage.GetGraphql(), usage.GetGraphqlRetryAtMs(), usage.GetSampledAtMs(), w)
		}})
	lines := []string{scheduler, m.muted("Shared authentication budget · includes other tools · GraphQL uses points"), budgets, "", text.Badge("Octo API traffic", m.theme), m.field("Since coordinator started", fmt.Sprintf("%d attempts · %d cache reuses · %d rate-limit responses", usage.GetRequests(), usage.GetCacheReuses(), usage.GetRateLimits())), m.field("Started", m.timestamp(usage.GetStartedAtMs(), fullTimestamp)), m.muted("Rolling hour · per-minute counts · current minute is partial · resets on restart")}

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
		m.muted("Chart times: "+m.zoneLabel()+" · HTTP attempts include transport failures; Git transport is excluded."),
		m.field("Metrics sampled", m.timestamp(usage.GetSampledAtMs(), fullTimestamp)))

	return strings.Join(lines, "\n")
}

func (m *Model) schedulerContent() string {
	status := m.snapshot.GetGithubScheduler()
	if status == nil {
		return m.muted("Scheduler cadence unavailable from this coordinator.")
	}

	activity := "idle"
	if status.GetInFlight() {
		activity = "1 active"
	}

	next := "awaiting work"
	if status.GetQueuedRequests() > 0 || status.GetInFlight() {
		next = m.timestamp(status.GetNextDispatchAtMs(), fullTimestamp)
	}

	lines := []string{text.Badge("GitHub scheduler", m.theme), m.field("Cadence", fmt.Sprintf("tick %s · minimum request gap %s", time.Duration(status.GetTickMs())*time.Millisecond, time.Duration(status.GetRequestSpacingMs())*time.Millisecond)), m.field("Requests", fmt.Sprintf("%d queued · %s", status.GetQueuedRequests(), activity)), m.field("Next eligible dispatch", next)}
	for _, cooldown := range []struct {
		name string
		at   int64
	}{{"REST", status.GetCoreRetryAtMs()}, {"GraphQL", status.GetGraphqlRetryAtMs()}} {
		if cooldown.at > m.snapshot.GetGithubUsage().GetSampledAtMs() {
			lines = append(lines, m.field(cooldown.name+" cooldown", m.timestamp(cooldown.at, fullTimestamp)))
		}
	}

	return strings.Join(lines, "\n") + "\n"
}
