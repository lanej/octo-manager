package tui

import (
	"fmt"
	"strings"
	"time"
)

const (
	fullTimestamp  = "2006-01-02 15:04:05 MST -0700"
	briefTimestamp = "Jan 2, 2006 · 15:04 MST -0700"
)

func DisplayLocation(name string) (*time.Location, error) {
	if name == "" || name == "local" {
		return time.Local, nil
	}

	location, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("invalid display timezone %q: %w", name, err)
	}

	return location, nil
}

func (m *Model) displayTime(ms int64) time.Time {
	return time.UnixMilli(ms).In(m.location)
}

func (m *Model) timestamp(ms int64, layout string) string {
	stamp := m.displayTime(ms)
	if stamp.Format("MST") == stamp.Format("-0700") {
		layout = strings.ReplaceAll(layout, "MST -0700", "-0700")
	}

	return stamp.Format(layout)
}

func (m *Model) zoneLabel() string {
	if m.location == time.Local {
		return "local time"
	}

	return m.location.String()
}
