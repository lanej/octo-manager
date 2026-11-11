package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	tea "charm.land/bubbletea/v2"
	"github.com/lanej/charmed/runtime"
	"github.com/lanej/charmed/theme"
	"github.com/lanej/octo-manager/internal/client"
	"github.com/lanej/octo-manager/internal/tui"
)

func main() {
	if err := run(); err != nil {
		if _, writeErr := fmt.Fprintln(os.Stderr, err); writeErr != nil {
			os.Exit(2)
		}

		os.Exit(1)
	}
}

func run() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	state := flag.String("state", filepath.Join(home, ".local", "state", "octo-manager"), "coordinator state directory")
	mode := flag.String("theme", "dark", "dark, light, contrast, or mono")

	zone := flag.String("timezone", "local", "display timezone: local (TZ or OS default), UTC, or an IANA name")

	flag.Parse()

	location, err := tui.DisplayLocation(*zone)
	if err != nil {
		return err
	}

	selected := theme.Mode(*mode)
	switch selected {
	case theme.Dark, theme.Light, theme.Contrast, theme.Mono:
	default:
		return fmt.Errorf("unsupported theme %q", *mode)
	}

	t := theme.New(selected)
	api := client.New(filepath.Join(*state, "run.sock"))
	scene := tui.New(context.Background(), api, t, location)
	root := &runtime.Root{Scene: scene, Background: t.Background, AltScreen: true, ASCII: t.ASCII}
	_, runErr := tea.NewProgram(root).Run()

	return errors.Join(runErr, root.Close())
}
