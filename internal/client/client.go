// Package client connects application clients to the local coordinator.
package client

import (
	"context"
	"net"
	"net/http"

	"connectrpc.com/connect"

	"github.com/lanej/octo-manager/gen/octomanager/v2/octomanagerv2connect"
)

type Client struct {
	RPC  octomanagerv2connect.SchedulerServiceClient
	http *http.Client
}

func New(socket string) *Client {
	dialer := &net.Dialer{}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, "unix", socket)
	}}
	httpClient := &http.Client{Transport: transport}

	raw := octomanagerv2connect.NewSchedulerServiceClient(httpClient, "http://localhost")
	interceptor := &versionInterceptor{raw: raw}

	return &Client{RPC: octomanagerv2connect.NewSchedulerServiceClient(httpClient, "http://localhost", connect.WithInterceptors(interceptor)), http: httpClient}
}

func (c *Client) Close() { c.http.CloseIdleConnections() }
