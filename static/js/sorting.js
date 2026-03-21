import { getNestedProperty } from './utils.js?v=2.3.7';

const FEATURED_COLUMN_TYPES = {
    'session_title': 'string',
    'channel.user.username': 'string',
    'viewer_count': 'number',
    'categories.0.name': 'string',
};

function sortData(data, sortState, column, type) {
    if (sortState.column === column) {
        sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        sortState.column = column;
        sortState.direction = 'desc';
    }

    data.sort((a, b) => {
        let valA = getNestedProperty(a, column);
        let valB = getNestedProperty(b, column);

        if (valA === undefined || valA === null) valA = (type === 'number' ? -Infinity : '');
        if (valB === undefined || valB === null) valB = (type === 'number' ? -Infinity : '');

        if (type === 'number') {
            valA = parseFloat(valA) || 0;
            valB = parseFloat(valB) || 0;
        } else {
            valA = String(valA).toLowerCase();
            valB = String(valB).toLowerCase();
        }

        if (valA < valB) return sortState.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortState.direction === 'asc' ? 1 : -1;
        return 0;
    });

    return { sortedData: data, newSortState: sortState };
}

export function sortVodsTable(vods, sortState, column, type) {
    return sortData(vods, sortState, column, type);
}

export function sortFeaturedStreamsTable(streams, sortState, column, type) {
    return sortData(streams, sortState, column, type);
}

export function applyFeaturedStreamsSort(streams, sortState) {
    const type = FEATURED_COLUMN_TYPES[sortState?.column];
    if (!sortState?.column || !type) {
        return [...streams];
    }

    return [...streams].sort((a, b) => {
        let valA = getNestedProperty(a, sortState.column);
        let valB = getNestedProperty(b, sortState.column);

        if (valA === undefined || valA === null) valA = (type === 'number' ? -Infinity : '');
        if (valB === undefined || valB === null) valB = (type === 'number' ? -Infinity : '');

        if (type === 'number') {
            valA = parseFloat(valA) || 0;
            valB = parseFloat(valB) || 0;
        } else {
            valA = String(valA).toLowerCase();
            valB = String(valB).toLowerCase();
        }

        if (valA < valB) return sortState.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortState.direction === 'asc' ? 1 : -1;
        return 0;
    });
}
