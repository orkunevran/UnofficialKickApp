package chromecast

// lru is a bounded, insertion-ordered set of known host strings — the Go analog
// of the OrderedDict used for _known_chromecast_hosts. Re-adding an existing
// host refreshes its recency; exceeding cap evicts the oldest. Not internally
// locked; callers (Service) hold the mutex.
type lru struct {
	cap   int
	order []string
	set   map[string]bool
}

func newLRU(capacity int) *lru {
	if capacity < 1 {
		capacity = 1
	}
	return &lru{cap: capacity, set: make(map[string]bool)}
}

// add inserts host, returning true only if it was newly added (so the caller
// knows to persist). Re-adding moves it to most-recent without reporting added.
func (l *lru) add(host string) bool {
	if host == "" {
		return false
	}
	if l.set[host] {
		l.moveToEnd(host)
		return false
	}
	l.set[host] = true
	l.order = append(l.order, host)
	for len(l.order) > l.cap {
		oldest := l.order[0]
		l.order = l.order[1:]
		delete(l.set, oldest)
	}
	return true
}

func (l *lru) moveToEnd(host string) {
	for i, h := range l.order {
		if h == host {
			l.order = append(l.order[:i], l.order[i+1:]...)
			break
		}
	}
	l.order = append(l.order, host)
}

func (l *lru) keys() []string {
	return append([]string(nil), l.order...)
}

func (l *lru) len() int { return len(l.order) }
