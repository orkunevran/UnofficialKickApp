export const appState = {
    vods: [],
    featuredStreams: [],
    clips: [],
    // Accumulated streams across multiple pages for client-side search
    searchPool: [],
};

export const vodsSortState = {
    column: 'created_at',
    direction: 'desc',
};

export const featuredSortState = {
    column: null,
    direction: 'desc',
};
