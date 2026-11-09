// Package client connects application clients to the local coordinator.
package client

import (
	"context"
	"net"
	"net/http"

	"github.com/lanej/octo-manager/gen/octomanager/v1/octomanagerv1connect"
)

type Client struct {
	RPC  octomanagerv1connect.SchedulerServiceClient
	http *http.Client
}

func New(socket string) *Client {
	dialer := &net.Dialer{}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, "unix", socket)
	}}
	httpClient := &http.Client{Transport: transport}

	return &Client{RPC: octomanagerv1connect.NewSchedulerServiceClient(httpClient, "http://localhost"), http: httpClient}
}

func (c *Client) Close() { c.http.CloseIdleConnections() }
