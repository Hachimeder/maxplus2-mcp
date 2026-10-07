/**
 * Original-vendor netlist extraction and EDIF 2.0.0 connectivity inspection.
 * This describes the compiled circuit. It does not decode GDF drawing geometry
 * or promise that synthesis preserves the drawing's original gate instances.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { detectInstall, runProcess } from './runtime.mjs';
import { parseAcf, validateAcf } from './acf.mjs';
import { parseReport } from './report.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tag = node => Array.isArray(node) && typeof node[0] === 'string' ? node[0].toLowerCase() : null;
const children = (node, kind) => node.slice(1).filter(item => tag(item) === kind.toLowerCase());
const child = (node, kind) => children(node, kind)[0];
const folded = value => String(value).toUpperCase();
const quoted = value => value && !Array.isArray(value) && typeof value === 'object' && Object.hasOwn(value, 'string');

function parseExpressions(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new Error('EDIF text must be a string no larger than 32 MiB');
  let position = 0;
  let nodes = 0;
  const fail = message => { throw new Error(`EDIF syntax at character ${position}: ${message}`); };
  const whitespace = () => { while (position < text.length && /\s/.test(text[position])) position++; };
  function expression(depth = 0) {
    if (++nodes > 1_000_000 || depth > 256) fail('structure exceeds the parsing limit');
    whitespace();
    if (position >= text.length) fail('unexpected end of file');
    if (text[position] === '(') {
      position++;
      const list = [];
      whitespace();
      while (position < text.length && text[position] !== ')') {
        list.push(expression(depth + 1));
        whitespace();
      }
      if (text[position] !== ')') fail('unclosed parenthesis');
      position++;
      if (typeof list[0] !== 'string') fail('list must begin with a keyword');
      return list;
    }
    if (text[position] === ')') fail('unexpected closing parenthesis');
    if (text[position] === '"') {
      position++;
      let value = '';
      while (position < text.length && text[position] !== '"') {
        // EDIF represents special characters using percent character codes.
        // Keep these verbatim rather than interpreting them as JS escapes.
        value += text[position++];
      }
      if (text[position] !== '"') fail('unterminated string');
      position++;
      return { string: value };
    }
    const start = position;
    while (position < text.length && !/[\s()"]/.test(text[position])) position++;
    if (start === position) fail('empty token');
    return text.slice(start, position);
  }
  const result = expression();
  whitespace();
  if (position !== text.length) fail('content after the root expression');
  return result;
}

function identifier(node) {
  if (typeof node === 'string' && node.length) return { id: node, name: node };
  if (tag(node) === 'rename' && typeof node[1] === 'string' && quoted(node[2])) return { id: node[1], name: node[2].string };
  throw new Error('unsupported or malformed EDIF identifier');
}

function nameDefinition(node) {
  if (tag(node) !== 'array') return { ...identifier(node), width: 1, dimensions: [] };
  const dimensions = node.slice(2).map(Number);
  if (dimensions.length !== 1 || !Number.isSafeInteger(dimensions[0]) || dimensions[0] < 1 || dimensions[0] > 1_000_000) {
    throw new Error('only bounded one-dimensional EDIF arrays are supported');
  }
  const name = identifier(node[1]);
  const range = /^(.*?)\[(-?\d+)\s*(?::|\.\.)\s*(-?\d+)\]$/.exec(name.name);
  const first = range ? Number(range[2]) : null;
  const last = range ? Number(range[3]) : null;
  const arrayRange = range && Number.isSafeInteger(first) && Number.isSafeInteger(last) && Math.abs(first - last) + 1 === dimensions[0]
    ? { base: range[1], first, last, step: first <= last ? 1 : -1, origin: 'EDIF renamed display label' } : null;
  return { ...name, width: dimensions[0], dimensions, arrayRange };
}

function reference(node) {
  if (tag(node) !== 'member') return { ...identifier(node), member: null };
  const index = Number(node[2]);
  if (node.length !== 3 || !Number.isSafeInteger(index) || index < 0) throw new Error('invalid EDIF array member');
  return { ...identifier(node[1]), member: index };
}

function properties(node) {
  return children(node, 'property').map(property => {
    const name = identifier(property[1]);
    const value = property[2];
    if (!Array.isArray(value)) return { ...name, type: 'unparsed', value };
    const kind = tag(value);
    let data = value.slice(1);
    if (kind === 'string' && quoted(value[1])) data = value[1].string;
    else if (kind === 'integer' && /^-?\d+$/.test(value[1] ?? '')) data = Number(value[1]);
    else if (kind === 'boolean') data = tag(value[1]) === 'true';
    return { ...name, type: kind, value: data };
  });
}

function parseView(node, library, cell, problems) {
  const name = identifier(node[1]);
  const type = child(node, 'viewType')?.[1]?.toUpperCase();
  const iface = child(node, 'interface');
  if (!iface) problems.push({ type: 'interface', cell: cell.id, view: name.id, message: 'view has no interface' });
  if (children(node, 'interface').length > 1 || children(node, 'contents').length > 1) problems.push({ type: 'duplicate', cell: cell.id, view: name.id, message: 'view has repeated interface or contents' });
  if (iface) for (const item of iface.slice(1)) {
    if (!['port', 'designator', 'property', 'comment', 'userdata', 'parameter'].includes(tag(item))) {
      problems.push({ type: 'unsupported', cell: cell.id, view: name.id, message: `unsupported interface construct ${tag(item) ?? 'atom'}` });
    }
  }
  const ports = iface ? children(iface, 'port').map(port => {
    const direction = child(port, 'direction')?.[1]?.toUpperCase();
    const def = nameDefinition(port[1]);
    if (!['INPUT', 'OUTPUT', 'INOUT'].includes(direction)) problems.push({ type: 'port', cell: cell.id, port: def.id, message: 'unsupported or missing port direction' });
    if (children(port, 'direction').length !== 1) problems.push({ type: 'port', cell: cell.id, port: def.id, message: 'port must have exactly one direction' });
    const designator = child(port, 'designator')?.[1];
    return { ...def, direction, pin: quoted(designator) ? designator.string : null, properties: properties(port) };
  }) : [];
  const contents = child(node, 'contents');
  const instances = contents ? children(contents, 'instance').map(instance => {
    const viewRef = child(instance, 'viewRef');
    const cellRef = viewRef ? child(viewRef, 'cellRef') : null;
    if (!viewRef || !cellRef) throw new Error('instance requires a supported viewRef/cellRef');
    const libRef = child(cellRef, 'libraryRef');
    return {
      ...identifier(instance[1]),
      library: libRef ? identifier(libRef[1]).id : library.id,
      cell: identifier(cellRef[1]).id,
      view: identifier(viewRef[1]).id,
      properties: properties(instance),
    };
  }) : [];
  const nets = contents ? children(contents, 'net').map(net => {
    const joined = child(net, 'joined');
    const def = nameDefinition(net[1]);
    const endpoints = [];
    if (!joined) problems.push({ type: 'net', cell: cell.id, net: def.id, message: 'net has no joined endpoint list' });
    if (children(net, 'joined').length > 1) problems.push({ type: 'duplicate', cell: cell.id, net: def.id, message: 'net has repeated joined endpoint lists' });
    for (const endpoint of joined?.slice(1) ?? []) {
      if (tag(endpoint) !== 'portref') {
        problems.push({ type: 'unsupported', cell: cell.id, net: def.id, message: `unsupported joined construct ${tag(endpoint) ?? 'atom'}` });
        continue;
      }
      const port = reference(endpoint[1]);
      const instanceRef = child(endpoint, 'instanceRef');
      if (child(endpoint, 'viewRef')) problems.push({ type: 'unsupported', cell: cell.id, net: def.id, message: 'hierarchical portRef viewRef is not supported' });
      if (endpoint.slice(2).some(item => !['instanceref', 'viewref'].includes(tag(item))) || children(endpoint, 'instanceRef').length > 1) problems.push({ type: 'unsupported', cell: cell.id, net: def.id, message: 'malformed or unsupported portRef qualifiers' });
      endpoints.push({ port: port.id, member: port.member, instance: instanceRef ? identifier(instanceRef[1]).id : null });
    }
    if (!endpoints.length) problems.push({ type: 'net', cell: cell.id, net: def.id, message: 'net has no supported endpoints' });
    return { ...def, endpoints, properties: properties(net) };
  }) : [];
  if (contents) for (const item of contents.slice(1)) {
    if (!['instance', 'net', 'property', 'comment', 'userData'].map(folded).includes(folded(tag(item)))) {
      problems.push({ type: 'unsupported', cell: cell.id, message: `unsupported contents construct ${tag(item) ?? 'atom'}` });
    }
  }
  const designator = iface ? child(iface, 'designator')?.[1] : null;
  return { ...name, type, deviceDesignator: quoted(designator) ? designator.string : null, ports, instances, nets };
}

/** Parse an original-vendor EDIF 2.0.0 netlist, validating every endpoint reference. */
export function parseNetlist(text) {
  const document = parseExpressions(text);
  if (tag(document) !== 'edif') throw new Error('expected an EDIF netlist');
  const version = child(document, 'edifVersion')?.slice(1).map(Number);
  if (!version || version.join('.') !== '2.0.0') throw new Error('only EDIF 2.0.0 netlists are supported; export EDIF_OUTPUT_VERSION = 200');
  if (Number(child(document, 'edifLevel')?.[1] ?? 0) !== 0 || Number(child(child(document, 'keywordMap') ?? [], 'keywordLevel')?.[1] ?? 0) !== 0) {
    throw new Error('EDIF levels and keyword aliases beyond level 0 are not supported');
  }
  const problems = [];
  const libraries = document.slice(1).filter(node => ['library', 'external'].includes(tag(node))).map(node => {
    const library = identifier(node[1]);
    const cells = children(node, 'cell').map(item => {
      const cell = identifier(item[1]);
      return { ...cell, views: children(item, 'view').map(view => parseView(view, library, cell, problems)) };
    });
    return { ...library, external: tag(node) === 'external', cells };
  });
  const cellMap = new Map();
  const key = (library, cell, view) => [library, cell, view].map(folded).join('/');
  for (const library of libraries) for (const cell of library.cells) for (const view of cell.views) {
    const id = key(library.id, cell.id, view.id);
    if (cellMap.has(id)) problems.push({ type: 'duplicate', message: `duplicate cell view ${id}` });
    cellMap.set(id, view);
  }
  for (const library of libraries) for (const cell of library.cells) for (const view of cell.views) {
    const instances = new Map();
    const ports = new Map();
    for (const port of view.ports) {
      if (ports.has(folded(port.id))) problems.push({ type: 'duplicate', cell: cell.id, message: `duplicate port ${port.id}` });
      ports.set(folded(port.id), port);
    }
    for (const instance of view.instances) {
      if (instances.has(folded(instance.id))) problems.push({ type: 'duplicate', cell: cell.id, message: `duplicate instance ${instance.id}` });
      instances.set(folded(instance.id), instance);
      if (!cellMap.has(key(instance.library, instance.cell, instance.view))) problems.push({ type: 'reference', cell: cell.id, instance: instance.id, message: 'referenced cell view is not declared' });
    }
    const connected = new Map();
    const netIds = new Set();
    for (const net of view.nets) {
      if (netIds.has(folded(net.id))) problems.push({ type: 'duplicate', cell: cell.id, message: `duplicate net ${net.id}` });
      netIds.add(folded(net.id));
      for (const endpoint of net.endpoints) {
        const instance = endpoint.instance === null ? null : instances.get(folded(endpoint.instance));
        if (endpoint.instance !== null && !instance) problems.push({ type: 'reference', cell: cell.id, net: net.id, message: `missing instance ${endpoint.instance}` });
        const target = endpoint.instance === null ? view : instance ? cellMap.get(key(instance.library, instance.cell, instance.view)) : null;
        const port = target?.ports.find(item => folded(item.id) === folded(endpoint.port));
        if (!port) problems.push({ type: 'reference', cell: cell.id, net: net.id, message: `missing port ${endpoint.instance ?? '(top)'}.${endpoint.port}` });
        else {
          endpoint.portName = port.name;
          endpoint.direction = port.direction;
          if ((endpoint.member !== null && (!port.dimensions.length || endpoint.member >= port.width || net.width !== 1)) || (endpoint.member === null && net.width !== port.width)) {
            problems.push({ type: 'reference', cell: cell.id, net: net.id, message: `port array member/width mismatch for ${endpoint.port}` });
          }
          if (endpoint.member !== null && port.arrayRange && endpoint.member < port.width) {
            endpoint.logicalIndex = port.arrayRange.first + port.arrayRange.step * endpoint.member;
            endpoint.portBitName = `${port.arrayRange.base}[${endpoint.logicalIndex}]`;
          }
          endpoint.role = port.direction === 'INOUT' ? 'bidirectional'
            : (endpoint.instance === null ? port.direction === 'INPUT' : port.direction === 'OUTPUT') ? 'driver' : 'load';
        }
        const endpointKey = `${folded(endpoint.instance ?? '')}/${folded(endpoint.port)}/${endpoint.member ?? ''}`;
        if (connected.has(endpointKey)) problems.push({ type: 'reference', cell: cell.id, net: net.id, message: `endpoint is repeated or also connected to ${connected.get(endpointKey)}` });
        connected.set(endpointKey, net.id);
      }
      net.drivers = net.endpoints.filter(endpoint => ['driver', 'bidirectional'].includes(endpoint.role));
      net.loads = net.endpoints.filter(endpoint => ['load', 'bidirectional'].includes(endpoint.role));
    }
  }
  const designNode = child(document, 'design');
  if (children(document, 'design').length !== 1) throw new Error('EDIF must have exactly one design');
  const cellRef = designNode ? child(designNode, 'cellRef') : null;
  const libRef = cellRef ? child(cellRef, 'libraryRef') : null;
  if (!cellRef || !libRef) throw new Error('EDIF design requires a cellRef/libraryRef');
  const design = { ...identifier(designNode[1]), library: identifier(libRef[1]).id, cell: identifier(cellRef[1]).id };
  const rootCell = libraries.find(item => folded(item.id) === folded(design.library))?.cells.find(item => folded(item.id) === folded(design.cell));
  const netlistViews = rootCell?.views.filter(item => item.type === 'NETLIST') ?? [];
  if (netlistViews.length !== 1) throw new Error('design must resolve to exactly one NETLIST view');
  const top = netlistViews[0];
  const written = child(child(document, 'status') ?? [], 'written');
  const program = written ? child(written, 'program') : null;
  return {
    format: 'EDIF', version: '2.0.0', name: identifier(document[1]).name,
    design: { ...design, view: top.id, deviceDesignator: top.deviceDesignator },
    ports: top.ports, instances: top.instances, nets: top.nets, libraries,
    counts: { ports: top.ports.length, instances: top.instances.length, nets: top.nets.length, endpoints: top.nets.reduce((sum, net) => sum + net.endpoints.length, 0) },
    provenance: { program: quoted(program?.[1]) ? program[1].string : null },
    validation: { ok: problems.length === 0, problems },
    understood: { ports: true, instances: true, connectivity: problems.length === 0, originalDrawingGeometry: false, originalInstancePreservation: false },
    limitations: ['Connectivity is the exported netlist view. Synthesis may merge, remove, or introduce instances; GDF drawing coordinates and original symbol placement are not represented.'],
  };
}

const INTERFACE_SETTINGS = {
  EDIF_NETLIST_WRITER: 'ON', EDIF_OUTPUT_VERSION: '200', EDIF_OUTPUT_FORCE_0NS_DELAYS: 'ON',
  EDIF_OUTPUT_DELAY_CONSTRUCTS: 'EDO_FILE', EDIF_OUTPUT_USE_EDC: 'OFF', EDIF_TRUNCATE_HIERARCHY_PATH: 'OFF',
  VHDL_NETLIST_WRITER: 'ON', VERILOG_NETLIST_WRITER: 'ON', VHDL_TRUNCATE_HIERARCHY_PATH: 'OFF', VERILOG_TRUNCATE_HIERARCHY_PATH: 'OFF',
  USE_SYNOPSYS_SYNTHESIS: 'OFF', USE_ADT_PALACE_FOR_MAX: 'OFF',
};
const PROCESSING_SETTINGS = { TIMING_SNF_EXTRACTOR: 'ON', FUNCTIONAL_SNF_EXTRACTOR: 'OFF', GENERATE_AHDL_TDO_FILE: 'ON', SMART_RECOMPILE: 'OFF', RPT_FILE_EQUATIONS: 'ON', RPT_FILE_HIERARCHY: 'ON' };

/** Set only the scratch-copy writer/processing configuration, preserving assignments. */
export function configureNetlistAcf(text, projectName) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(projectName)) throw new Error('unsupported project basename for isolated export');
  let source = String(text ?? '');
  const defaultDevice = !source.trim() ? 'EP1K10TC100-1' : null;
  if (defaultDevice) source = `CHIP ${projectName}\r\nBEGIN\r\n\tDEVICE = ${defaultDevice};\r\nEND;\r\n`;
  for (const [sectionName, settings] of [['COMPILER_INTERFACES_CONFIGURATION', INTERFACE_SETTINGS], ['COMPILER_PROCESSING_CONFIGURATION', PROCESSING_SETTINGS]]) {
    const parsed = parseAcf(source);
    const sections = parsed.sections.filter(section => section.name === sectionName);
    if (sections.length > 1 || sections.some(section => section.unterminated)) throw new Error(`cannot safely configure duplicate or unterminated ${sectionName}`);
    const lines = source.split(/\r?\n/);
    const section = sections[0];
    if (section) {
      const body = lines.slice(section.headerLine - 1, section.endLine - 1).filter(line => {
        const match = /^\s*([^=;]+?)\s*=/.exec(line);
        return !match || !Object.hasOwn(settings, match[1].trim().toUpperCase());
      });
      body.push(...Object.entries(settings).map(([name, value]) => `\t${name} = ${value};`), 'END;');
      lines.splice(section.headerLine - 1, section.endLine - section.headerLine + 1, ...body);
      source = lines.join('\r\n');
    } else source += `\r\n${sectionName}\r\nBEGIN\r\n${Object.entries(settings).map(([name, value]) => `\t${name} = ${value};`).join('\r\n')}\r\nEND;\r\n`;
  }
  const validation = validateAcf(source, { expectedProjectName: projectName });
  if (!validation.ok) throw new Error(`scratch ACF is invalid: ${JSON.stringify(validation.problems)}`);
  return { text: source, defaultDevice, settings: { ...INTERFACE_SETTINGS, ...PROCESSING_SETTINGS } };
}

const COPY_EXTENSIONS = new Set(['.acf', '.gdf', '.vhd', '.vhdl', '.v', '.tdf', '.edf', '.edif', '.inc', '.sym', '.mif', '.hex', '.lmf', '.edc', '.wdf', '.adf', '.smf', '.tdx']);
const DESIGN_EXTENSIONS = new Set(['.gdf', '.vhd', '.vhdl', '.v', '.tdf', '.edf', '.edif']);
const TEXT_SOURCES = new Set(['.acf', '.vhd', '.vhdl', '.v', '.tdf', '.edf', '.edif', '.inc', '.lmf', '.edc']);
const inside = (candidate, directory) => {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Compile an isolated source-directory copy and inspect original-vendor EDIF output. */
export async function exportNetlist({ source, root, timeoutMs = 60_000, signal, onSpawn } = {}) {
  if (signal?.aborted) throw new Error('cancelled before preparing isolated netlist export');
  if (typeof source !== 'string') throw new Error('source must be the path of a project ACF or design source file');
  const sourcePath = fs.realpathSync(source);
  const extension = path.extname(sourcePath).toLowerCase();
  if (!['.acf', '.gdf', '.vhd', '.vhdl', '.v', '.tdf', '.edf', '.edif'].includes(extension) || !fs.statSync(sourcePath).isFile()) throw new Error('unsupported netlist source file');
  const name = path.basename(sourcePath, path.extname(sourcePath));
  const sourceDir = path.dirname(sourcePath);
  if (extension !== '.acf') {
    const competing = fs.readdirSync(sourceDir).filter(file =>
      DESIGN_EXTENSIONS.has(path.extname(file).toLowerCase())
      && path.basename(file, path.extname(file)).toLowerCase() === name.toLowerCase()
      && path.resolve(sourceDir, file).toLowerCase() !== sourcePath.toLowerCase());
    if (competing.length) throw new Error(`ambiguous top-level design source for ${name}: ${[path.basename(sourcePath), ...competing].join(', ')}; request its ACF to use the existing project source selection, or isolate the requested source`);
  }
  const install = detectInstall(root);
  if (!install?.executable || (root && fs.realpathSync(install.root).toLowerCase() !== fs.realpathSync(root).toLowerCase())) throw new Error('requested MAX+plus II installation was not found');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new Error('timeoutMs must be between 1 and 900000');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maxplus2-netlist-'));
  const projectDir = path.join(scratch, 'project');
  fs.mkdirSync(projectDir);
  const sourceManifest = [];
  let totalBytes = 0;
  function copyDirectory(dir, relative = '', depth = 0) {
    if (depth > 16) throw new Error('source hierarchy exceeds 16 levels');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.codex', '.mcp-backups', 'node_modules'].includes(entry.name)) continue;
      if (signal?.aborted) throw new Error('cancelled while copying sources');
      const original = path.join(dir, entry.name);
      const local = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`isolated export cannot copy a symlink/junction dependency: ${local}`);
      if (entry.isDirectory()) {
        fs.mkdirSync(path.join(projectDir, local));
        copyDirectory(original, local, depth + 1);
      } else if (entry.isFile() && COPY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const size = fs.statSync(original).size;
        if (size > 32 * 1024 * 1024 || totalBytes + size > 128 * 1024 * 1024 || sourceManifest.length >= 2000) throw new Error('source copy exceeds the isolated-export limits');
        const bytes = fs.readFileSync(original);
        totalBytes += bytes.length;
        if (bytes.length > 32 * 1024 * 1024 || totalBytes > 128 * 1024 * 1024 || sourceManifest.length >= 2000) throw new Error('source copy exceeds the isolated-export limits');
        const target = path.join(projectDir, local);
        fs.writeFileSync(target, bytes, { flag: 'wx' });
        sourceManifest.push({ path: original, relativePath: local, bytes: bytes.length, sha256: hash(bytes), scratchPath: target });
      }
    }
  }
  try {
    copyDirectory(sourceDir);
    // An absolute user-source/output reference could make the compiler access
    // the original tree. Remap references inside the copied tree and reject
    // external absolute references instead of quietly exporting a mixed tree.
    for (const item of sourceManifest) if (TEXT_SOURCES.has(path.extname(item.relativePath).toLowerCase())) {
      let text = fs.readFileSync(item.scratchPath, 'latin1');
      const escaped = sourceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`${escaped}(?=[\\\\/\\s;"']|$)`, 'gi'), projectDir);
      const slashEscaped = sourceDir.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`${slashEscaped}(?=[/\\s;"']|$)`, 'gi'), projectDir.replaceAll('\\', '/'));
      for (const absolute of text.matchAll(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n;"'<>]*/g)) {
        const value = absolute[0].trim();
        if (!inside(value, projectDir) && !inside(value, install.root)) {
          throw new Error(`external absolute path in ${item.relativePath}: ${value}; copy this dependency into the source directory first`);
        }
      }
      if (/(?:^|[\s"'=:(])\.\.[\\/]/m.test(text)) throw new Error(`parent-relative path in ${item.relativePath}: isolate this dependency inside the source directory first`);
      fs.writeFileSync(item.scratchPath, text, 'latin1');
    }
    const acfPath = path.join(projectDir, `${name}.acf`);
    const existing = fs.existsSync(acfPath) ? fs.readFileSync(acfPath, 'latin1') : '';
    const configured = configureNetlistAcf(existing, name);
    fs.writeFileSync(acfPath, configured.text, 'latin1');
    if (signal?.aborted) throw new Error('cancelled before compiler spawn');
    const result = await runProcess(install.executable, ['-c', name], { cwd: projectDir, timeoutMs, signal, onSpawn });
    const reportPath = path.join(projectDir, `${name}.rpt`);
    const report = fs.existsSync(reportPath) ? parseReport(fs.readFileSync(reportPath, 'latin1')) : null;
    const outputs = fs.readdirSync(projectDir).filter(file => /\.(edo|vho|vo|tdo|sdo)$/i.test(file)).map(file => {
      const outputPath = path.join(projectDir, file);
      const bytes = fs.readFileSync(outputPath);
      return { path: outputPath, extension: path.extname(file).toLowerCase(), bytes: bytes.length, sha256: hash(bytes) };
    });
    const netlistJson = [];
    const parseProblems = [];
    for (const output of outputs.filter(item => item.extension === '.edo')) {
      try { netlistJson.push({ path: output.path, sha256: output.sha256, ...parseNetlist(fs.readFileSync(output.path, 'latin1')) }); }
      catch (error) { parseProblems.push({ path: output.path, message: error.message }); }
    }
    const changedSources = sourceManifest.filter(item => !fs.existsSync(item.path) || hash(fs.readFileSync(item.path)) !== item.sha256).map(item => item.path);
    const banner = /Project compilation was successful/i.test(result.stdout + result.stderr);
    const verified = result.code === 0 && !result.aborted && !result.timedOut && !result.spawnError && banner && report?.status === 'successful'
      && netlistJson.length > 0 && netlistJson.every(item => item.validation.ok) && parseProblems.length === 0 && changedSources.length === 0;
    return {
      source: { path: sourcePath, sha256: sourceManifest.find(item => item.path === sourcePath)?.sha256 },
      sourceManifest, sourceIntegrity: { unchanged: changedSources.length === 0, changed: changedSources },
      scratch, projectDir, scratchAcf: acfPath, defaultDevice: configured.defaultDevice,
      sourceSelection: extension === '.acf' ? 'MAX+plus II existing project source selection' : 'unambiguous design source basename',
      exportPaths: outputs, netlistJson, parseProblems,
      compile: { executable: install.executable, argv: ['-c', name], exitCode: result.code, aborted: Boolean(result.aborted), timedOut: result.timedOut, durationMs: result.durationMs, successBanner: banner, reportPath: report ? reportPath : null, reportStatus: report?.status ?? 'unknown', counts: report?.counts ?? null, stdoutTail: result.stdout.slice(-4000), stderrTail: result.stderr.slice(-2000), spawnError: result.spawnError ?? null },
      verdict: verified ? 'verified-export' : 'not-verified',
      limitations: ['This is a synthesized device netlist, not GDF drawing geometry or guaranteed preservation of the original schematic gate instances.', 'The compiler ran only in a temporary source copy. External absolute user dependencies and junctions are rejected; the original files are retained.', 'The scratch copy and exported original-vendor files are retained for inspection.'],
    };
  } catch (error) {
    error.message += ` (isolated scratch retained at ${scratch})`;
    throw error;
  }
}
