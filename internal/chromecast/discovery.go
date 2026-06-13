package chromecast

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/vishen/go-chromecast/application"
	"github.com/vishen/go-chromecast/dns"
)

// mdnsDiscover runs go-chromecast mDNS discovery until ctx expires.
func (s *Service) mdnsDiscover(ctx context.Context) ([]Device, error) {
	ch, err := dns.DiscoverCastDNSEntries(ctx, nil)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var out []Device
	for entry := range ch { // channel closes when ctx is done
		uuid := entry.GetUUID()
		if uuid == "" || seen[uuid] {
			continue
		}
		seen[uuid] = true
		out = append(out, Device{
			UUID: uuid,
			Name: entry.GetName(),
			Addr: entry.GetAddr(),
			Port: entry.GetPort(),
		})
	}
	return out, nil
}

// newRealCaster connects a go-chromecast Application to addr:port.
func newRealCaster(addr string, port int) (caster, error) {
	app := application.NewApplication(application.WithConnectionRetries(3))
	if err := app.Start(addr, port); err != nil {
		return nil, err
	}
	return app, nil
}

// ── fallback TCP subnet scan ───────────────────────────────────────────────────

// fallbackScan probes the local subnet(s) for port 8009 and resolves device
// info for responders. Ported from _scan_private_networks_for_chromecasts.
func (s *Service) fallbackScan() []Device {
	nets := s.detectLocalSubnet()
	hosts := candidateHosts(nets)
	if len(hosts) == 0 {
		return nil
	}
	s.log.Info("fallback scan probing hosts for port 8009", "hosts", len(hosts), "subnets", len(nets))

	workers := s.cfg.FallbackScanWorkers
	if workers < 1 {
		workers = 32
	}
	jobs := make(chan string)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var found []Device
	seen := make(map[string]bool)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for h := range jobs {
				if !probeHost(h, s.cfg.FallbackProbeTimeout) {
					continue
				}
				dev, ok := fetchDeviceInfo(h, s.cfg.FallbackInfoTimeout)
				if !ok {
					continue
				}
				mu.Lock()
				if !seen[dev.UUID] {
					seen[dev.UUID] = true
					found = append(found, dev)
				}
				mu.Unlock()
			}
		}()
	}
	for _, h := range hosts {
		jobs <- h
	}
	close(jobs)
	wg.Wait()
	return found
}

// probeHost reports whether host:8009 accepts a TCP connection.
func probeHost(host string, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, "8009"), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// fetchDeviceInfo queries a Cast device's eureka_info for name + UUID. Tries the
// modern HTTPS endpoint then the legacy HTTP one (cert verification disabled —
// these are self-signed LAN devices). Mirrors pychromecast.dial.get_device_info.
func fetchDeviceInfo(host string, timeout time.Duration) (Device, bool) {
	client := &http.Client{
		Timeout:   timeout,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, //nolint:gosec // LAN self-signed
	}
	for _, url := range []string{
		"https://" + host + ":8443/setup/eureka_info?options=detail",
		"http://" + host + ":8008/setup/eureka_info?options=detail",
	} {
		resp, err := client.Get(url)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			continue
		}
		var info struct {
			Name    string `json:"name"`
			SSDPUdn string `json:"ssdp_udn"`
		}
		if json.Unmarshal(body, &info) != nil {
			continue
		}
		uuid := info.SSDPUdn
		if uuid == "" {
			uuid = host
		}
		name := info.Name
		if name == "" {
			name = host
		}
		return Device{UUID: uuid, Name: name, Addr: host, Port: 8009}, true
	}
	return Device{}, false
}

// detectLocalSubnet derives the active /24 from the outbound interface, falling
// back to the configured subnets. Ports _detect_local_subnet.
func (s *Service) detectLocalSubnet() []*net.IPNet {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err == nil {
		defer conn.Close()
		if ua, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			if ip4 := ua.IP.To4(); ip4 != nil {
				if _, ipnet, e := net.ParseCIDR(fmt.Sprintf("%d.%d.%d.0/24", ip4[0], ip4[1], ip4[2])); e == nil {
					return []*net.IPNet{ipnet}
				}
			}
		}
	}
	return parseSubnets(s.cfg.FallbackScanSubnets)
}

var subnetSep = regexp.MustCompile(`[,\s]+`)

// parseSubnets parses a comma/space-separated list of CIDRs.
func parseSubnets(raw string) []*net.IPNet {
	var nets []*net.IPNet
	for _, part := range subnetSep.Split(raw, -1) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if _, ipnet, err := net.ParseCIDR(part); err == nil {
			nets = append(nets, ipnet)
		}
	}
	return nets
}

// candidateHosts enumerates usable host IPs (excluding network and broadcast)
// across the given subnets, capped to avoid pathological large ranges.
func candidateHosts(nets []*net.IPNet) []string {
	const maxHosts = 4096
	var hosts []string
	for _, n := range nets {
		ip4 := n.IP.To4()
		if ip4 == nil {
			continue
		}
		ones, bits := n.Mask.Size()
		if bits-ones > 12 { // skip ranges larger than ~/20 (>4094 hosts)
			continue
		}
		network := ip4.Mask(n.Mask)
		bcast := broadcastIP(n)
		for ip := incIP(network); n.Contains(ip) && !ip.Equal(bcast); ip = incIP(ip) {
			hosts = append(hosts, ip.String())
			if len(hosts) >= maxHosts {
				return hosts
			}
		}
	}
	return hosts
}

func incIP(ip net.IP) net.IP {
	out := append(net.IP(nil), ip.To4()...)
	for i := len(out) - 1; i >= 0; i-- {
		out[i]++
		if out[i] != 0 {
			break
		}
	}
	return out
}

func broadcastIP(n *net.IPNet) net.IP {
	ip := n.IP.To4()
	b := make(net.IP, 4)
	for i := 0; i < 4; i++ {
		b[i] = ip[i] | ^n.Mask[i]
	}
	return b
}
