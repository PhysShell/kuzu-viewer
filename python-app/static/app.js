let cy = null;

// DOM Elements
const connectScreen = document.getElementById('connect-screen');
const mainScreen = document.getElementById('main-screen');
const connectBtn = document.getElementById('connect-btn');
const dbPathInput = document.getElementById('db-path');
const readOnlyCheckbox = document.getElementById('read-only-checkbox');
const connectError = document.getElementById('connect-error');
const disconnectBtn = document.getElementById('disconnect-btn');
const dbStatus = document.getElementById('db-status');

const tabBtns = document.querySelectorAll('.tab-btn');
const views = document.querySelectorAll('.view');
const schemaList = document.getElementById('schema-list');
const dataTableContainer = document.getElementById('data-table-container');
const currentTableName = document.getElementById('current-table-name');
const nodeDetails = document.getElementById('node-details');

const modal = document.getElementById('cypher-modal');
const runQueryBtn = document.getElementById('run-query-btn');
const closeBtn = document.querySelector('.close-btn');
const executeBtn = document.getElementById('execute-btn');
const cypherInput = document.getElementById('cypher-input');
const cypherResult = document.getElementById('cypher-result');
const refreshSchemaBtn = document.getElementById('refresh-schema');

// Connect
connectBtn.addEventListener('click', async () => {
    const path = dbPathInput.value;
    const readOnly = readOnlyCheckbox.checked;
    connectBtn.disabled = true;
    connectBtn.innerText = 'Connecting...';
    try {
        const res = await fetch('/api/connect', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({path, read_only: readOnly})
        });
        const data = await res.json();
        if (res.ok) {
            connectScreen.classList.remove('active');
            mainScreen.classList.add('active');
            const modeLabel = readOnly ? 'read-only' : 'read-write';
            const snapshotNote = data.temp_copy ? ' · snapshot (DB was locked)' : '';
            dbStatus.innerText = `${path} (${modeLabel})${snapshotNote}`;
            dbStatus.title = data.message || '';
            initGraph();
            loadSchema();
        } else {
            connectError.innerText = data.detail || 'Connection failed';
        }
    } catch (e) {
        connectError.innerText = e.message;
    } finally {
        connectBtn.disabled = false;
        connectBtn.innerText = 'Connect';
    }
});

// Disconnect / release DB
disconnectBtn.addEventListener('click', async () => {
    console.log('[kuzu-viewer] Close DB clicked');
    disconnectBtn.disabled = true;
    const originalLabel = disconnectBtn.innerText;
    disconnectBtn.innerText = 'Closing...';
    try {
        const res = await fetch('/api/disconnect', {method: 'POST'});
        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`Server returned ${res.status}: ${errBody}`);
        }
        if (cy) {
            cy.destroy();
            cy = null;
        }
        schemaList.innerHTML = '';
        dataTableContainer.innerHTML = '<p class="placeholder-text">Table data will appear here.</p>';
        currentTableName.innerText = 'Select a Table';
        nodeDetails.innerHTML = 'Select a node or edge...';
        mainScreen.classList.remove('active');
        connectScreen.classList.add('active');
        connectError.innerText = '';
    } catch (e) {
        console.error('Disconnect failed', e);
        alert(`Close DB failed: ${e.message}`);
    } finally {
        disconnectBtn.disabled = false;
        disconnectBtn.innerText = originalLabel;
    }
});

// Tabs
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        views.forEach(v => v.classList.remove('active'));
        
        btn.classList.add('active');
        document.getElementById(`${btn.dataset.view}-view`).classList.add('active');
        
        if (btn.dataset.view === 'graph' && cy) {
            cy.resize();
            cy.fit();
        }
    });
});

// Load Graph
async function initGraph() {
    try {
        const res = await fetch('/api/graph');
        const data = await res.json();
        
        // Pick a human-readable display name for each node, preferring
        // common name-like properties over the table label.
        const NAME_KEYS = ['name', 'title', 'label_name', 'displayName', 'display_name', 'username', 'email', 'db_id'];
        const truncate = (s, n) => {
            s = String(s);
            return s.length > n ? s.slice(0, n - 1) + '…' : s;
        };
        data.nodes.forEach(node => {
            const d = node.data;
            let display = null;
            for (const k of NAME_KEYS) {
                if (d[k] !== undefined && d[k] !== null && String(d[k]).length) {
                    display = d[k];
                    break;
                }
            }
            if (!display) {
                // Fallback: any non-internal scalar property, else the table label.
                for (const [k, v] of Object.entries(d)) {
                    if (['id', 'label', 'source', 'target'].includes(k)) continue;
                    if (v !== null && v !== undefined && typeof v !== 'object') {
                        display = v;
                        break;
                    }
                }
            }
            d.displayName = truncate(display ?? d.label ?? '', 24);
        });

        const elements = [...data.nodes, ...data.edges];

        cy = cytoscape({
            container: document.getElementById('cy'),
            elements: elements,
            style: [
                {
                    selector: 'node',
                    style: {
                        'background-color': '#3b82f6',
                        'label': 'data(displayName)',
                        'color': '#0f172a',
                        'text-valign': 'bottom',
                        'text-halign': 'center',
                        'text-margin-y': 6,
                        'font-size': '11px',
                        'font-weight': 500,
                        'text-background-color': '#ffffff',
                        'text-background-opacity': 0.85,
                        'text-background-padding': '2px',
                        'text-background-shape': 'round-rectangle',
                        'width': '36px',
                        'height': '36px',
                        'border-width': 2,
                        'border-color': '#1d4ed8'
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'width': 1.5,
                        'line-color': '#94a3b8',
                        'target-arrow-color': '#94a3b8',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'label': 'data(label)',
                        'font-size': '9px',
                        'color': '#475569',
                        'text-rotation': 'autorotate',
                        'text-margin-y': -8,
                        'text-background-color': '#ffffff',
                        'text-background-opacity': 0.8,
                        'text-background-padding': '1px'
                    }
                }
            ],
            layout: {
                name: 'cose',
                animate: false
            }
        });

        cy.on('tap', 'node, edge', function(evt){
            const ele = evt.target;
            const data = ele.data();
            let html = '';
            for (const [key, value] of Object.entries(data)) {
                if(['id','source','target','displayName'].includes(key)) continue;
                html += `<div class="prop-row"><span class="prop-key">${key}:</span> ${value}</div>`;
            }
            nodeDetails.innerHTML = html || 'No properties';
        });

    } catch (e) {
        console.error("Failed to load graph", e);
    }
}

// Load Schema
async function loadSchema() {
    try {
        const res = await fetch('/api/schema');
        const data = await res.json();
        schemaList.innerHTML = '';
        
        data.schema.forEach(table => {
            const li = document.createElement('li');
            li.className = 'schema-item';
            const badgeClass = table.type === 'NODE' ? 'node' : 'rel';
            li.innerHTML = `
                <span class="badge ${badgeClass}">${table.type}</span>
                <span>${table.name}</span>
            `;
            li.addEventListener('click', () => {
                document.querySelectorAll('.schema-item').forEach(el => el.classList.remove('active'));
                li.classList.add('active');
                loadTableData(table.name);
            });
            schemaList.appendChild(li);
        });
    } catch(e) {
        console.error("Failed to load schema", e);
    }
}

refreshSchemaBtn.addEventListener('click', loadSchema);

// Load Table Data
async function loadTableData(tableName) {
    currentTableName.innerText = tableName;
    dataTableContainer.innerHTML = '<p class="placeholder-text">Loading...</p>';
    try {
        const res = await fetch(`/api/tables/${tableName}`);
        const { data } = await res.json();
        
        if (data.length === 0) {
            dataTableContainer.innerHTML = '<p class="placeholder-text">Table is empty.</p>';
            return;
        }

        // Generate table
        const keys = new Set();
        data.forEach(row => {
            Object.keys(row).forEach(k => {
                if(!k.startsWith('_')) keys.add(k);
            });
        });
        
        const keyArray = Array.from(keys);
        
        let html = '<table><thead><tr>';
        keyArray.forEach(k => html += `<th>${k}</th>`);
        html += '</tr></thead><tbody>';
        
        data.forEach(row => {
            html += '<tr>';
            keyArray.forEach(k => {
                html += `<td>${row[k] !== undefined && row[k] !== null ? row[k] : ''}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        
        dataTableContainer.innerHTML = html;
        
    } catch(e) {
        dataTableContainer.innerHTML = `<p class="error-msg">Failed to load data: ${e.message}</p>`;
    }
}

// Modal handling
runQueryBtn.addEventListener('click', () => {
    modal.classList.add('active');
    cypherResult.style.display = 'none';
    cypherInput.value = '';
});

closeBtn.addEventListener('click', () => {
    modal.classList.remove('active');
});

window.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
});

executeBtn.addEventListener('click', async () => {
    const query = cypherInput.value;
    if(!query) return;
    
    executeBtn.disabled = true;
    try {
        const res = await fetch('/api/query', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({query})
        });
        const data = await res.json();
        
        cypherResult.style.display = 'block';
        if(res.ok) {
            cypherResult.style.color = '#047857';
            cypherResult.innerText = JSON.stringify(data, null, 2);
            // Refresh graph and schema if data changed
            loadSchema();
            if(cy) {
                cy.destroy();
                initGraph();
            }
        } else {
            cypherResult.style.color = '#ef4444';
            cypherResult.innerText = data.detail || 'Query failed';
        }
    } catch(e) {
        cypherResult.style.display = 'block';
        cypherResult.style.color = '#ef4444';
        cypherResult.innerText = e.message;
    } finally {
        executeBtn.disabled = false;
    }
});
