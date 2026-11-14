package tui

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	v1 "github.com/lanej/octo-manager/gen/octomanager/v1"
)

type subject struct {
	key     string
	url     string
	label   string
	jobs    []*v1.Job
	tracked *v1.TrackedPullRequest
}

func pullRequest(job *v1.Job) (string, string) {
	return parsePRURL(job.GetTask().GetSummarizePullRequest().GetUrl())
}

func parsePRURL(raw string) (string, string) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", ""
	}

	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" || !githubName(parts[0]) || !githubName(parts[1]) {
		return "", ""
	}

	number, err := strconv.ParseUint(parts[3], 10, 64)
	if err != nil || number == 0 {
		return "", ""
	}

	parts[0], parts[1] = strings.ToLower(parts[0]), strings.ToLower(parts[1])
	canonical := "https://github.com/" + parts[0] + "/" + parts[1] + "/pull/" + strconv.FormatUint(number, 10)

	return canonical, parts[0] + "/" + parts[1] + "#" + strconv.FormatUint(number, 10)
}

func githubName(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}

	for _, r := range value {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-", r) {
			return false
		}
	}

	return true
}

func (m *Model) subjects() []subject {
	var prs, other []subject

	indices := map[string]int{}

	for _, tracked := range m.snapshot.GetTracking().GetPrs() {
		address, label := parsePRURL(tracked.GetUrl())
		if address == "" {
			continue
		}

		indices[address] = len(prs)
		prs = append(prs, subject{key: address, url: address, label: label, tracked: tracked})
	}

	for _, job := range m.snapshot.GetJobs() {
		address, label := pullRequest(job)
		if address == "" {
			label = "Unrecognized task"
			if job.GetTask().GetResolveConflict() != nil {
				label = "Conflict demo"
			}

			other = append(other, subject{key: job.GetId(), label: label, jobs: []*v1.Job{job}})

			continue
		}

		if index, ok := indices[address]; ok {
			prs[index].jobs = append(prs[index].jobs, job)
			continue
		}

		indices[address] = len(prs)
		prs = append(prs, subject{key: address, url: address, label: label, jobs: []*v1.Job{job}})
	}

	return append(prs, other...)
}

func (m *Model) currentSubject() subject {
	for _, item := range m.subjects() {
		if item.key == m.selected {
			return item
		}

		for _, job := range item.jobs {
			if job.GetId() == m.selected {
				return item
			}
		}
	}

	return subject{}
}

func (m *Model) moveRun(delta int) {
	jobs := m.currentSubject().jobs
	for i, job := range jobs {
		if job.GetId() == m.selected {
			m.selectJob(jobs[min(max(0, i+delta), len(jobs)-1)])
			return
		}
	}
}

func (m *Model) selectJob(job *v1.Job) {
	old := m.currentSubject().key

	m.selected = job.GetId()

	m.history = historyState{version: m.history.version + 1}
	if old != m.currentSubject().key {
		m.panel = reviewsPanel
		if m.currentSubject().url == "" {
			m.panel = statePanel
		}
	}

	m.result.GotoTop()

	if m.panel != trackingPanel {
		m.activity.GotoBottom()
	}

	m.resizeContent()
}

func browserCommand(ctx context.Context, platform, address string) (*exec.Cmd, error) {
	canonical, _ := parsePRURL(address)
	if canonical == "" {
		return nil, fmt.Errorf("a valid GitHub PR URL is required")
	}

	switch platform {
	case "darwin":
		//nolint:gosec // Validated HTTPS GitHub PR URL is one argument to a fixed opener; no shell.
		return exec.CommandContext(ctx, "open", canonical), nil
	case "linux":
		//nolint:gosec // Validated HTTPS GitHub PR URL is one argument to a fixed opener; no shell.
		return exec.CommandContext(ctx, "xdg-open", canonical), nil
	default:
		return nil, fmt.Errorf("browser opening is unsupported on %s; use %s", platform, address)
	}
}

func (m *Model) openPullRequest() tea.Cmd {
	address := m.currentSubject().url
	if address == "" {
		m.commandError = "This demo has no GitHub PR URL"
		return nil
	}

	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
		defer cancel()

		command, err := browserCommand(ctx, runtime.GOOS, address)
		if err != nil {
			return browserMsg{err: err}
		}

		return browserMsg{err: command.Run()}
	}
}
