import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Project, EditorState, ArchElement, Point, EditorTool, DockPosition, UnitSystem, Level, DrawingViewId, ElevationDirection, ElementType } from './types';
import { Toolbox, DrawBar, SnapBar } from './components/Toolbar';
import Canvas, { CanvasHandle, VectorPdfExportOptions } from './components/Canvas';
import PdfExportDialog from './components/PdfExportDialog';
import Viewer3D, { View3DCameraFrame } from './components/Viewer3D';
import { ViewportCompass } from './components/ViewportCompass';
import PropertiesPanel from './components/PropertiesPanel';
import GenerativeWizard, { GenerativeWizardMode } from './components/GenerativeWizard';
import { digitizeFloorplan } from './services/redrawService';
import { convertDxfWithAI } from './services/aiDxfService';
import { DxfAngleType, DxfImportUnit, DxfLengthType, DxfLightingUnit, DxfUnitSettings, detectDxfUnitSettings, importDxfToProject, pairLinesToWalls } from './services/dxfImportService';
import { ProceduralLayoutEngine } from './services/proceduralService';
import { ProceduralFurnishEngine } from './services/furnishService';
import ProceduralWizard from './components/ProceduralWizard';
import { SmartProceduralLayoutEngine } from './smart-procedural/smartProceduralService';
import { SmartProceduralFurnishEngine } from './smart-procedural/smartFurnishService';
import SmartProceduralWizard from './smart-procedural/SmartProceduralWizard';
import { SiteLocation, TerrainSettings, LayoutTypology, LayoutGeometry, ProceduralConfig } from './types';
import UrbanWizard from './components/UrbanWizard';
import { BlockEditor } from './components/BlockEditor';
import { UrbanDashboard } from './components/UrbanDashboard';
import { UrbanPlanParams, UrbanGeneratorService } from './services/urbanService';
import { SiteMapPanel } from './components/SiteMapPanel';
import { SiteImportWizard } from './components/SiteImportWizard';
import { AuthModal } from './components/AuthModal';
import { ProjectsPanel } from './components/ProjectsPanel';
import { AccountPanel } from './components/AccountPanel';
import { TokensPanel } from './components/TokensPanel';
import { watchAccountBalance, EMPTY_BALANCE, type AccountBalance } from './services/billing/balanceClient';
import { watchAuthState, signOut as firebaseSignOut, completeGoogleRedirectSignIn } from './services/firebase/authService';
import { isFirebaseConfigured } from './services/firebase/firebaseConfig';
import { API_AUTH_REQUIRED_EVENT, TOKENS_REQUIRED_EVENT } from './services/firebase/apiAuthInterceptor';
import type { User as FirebaseUser } from 'firebase/auth';
import { RevitImportWizard } from './components/RevitImportWizard';
import { BimImporterWizard } from './components/BimImporterWizard';
import { BimExporterDialog } from './components/BimExporterDialog';
import { RevitExporterDialog } from './components/RevitExporterDialog';
import { ApsRevitImporterDialog } from './components/ApsRevitImporterDialog';
import { BimService } from './services/bimService';
import { BimImportSession } from './services/bimImportService';
import { BimExportResult } from './services/bimExportService';
import { RevitExportJobResponse } from './services/revitExport/revitExportTypes';
import { 
  Upload, Loader2, Save, FileJson, Plus, CheckCircle2, Boxes, Sparkles, Layers as LayersIcon, ChevronDown, ChevronLeft, Globe, Home, Wand2, ScanLine, Hammer,
  GripVertical, GripHorizontal, FileDown, FileUp, Database, DatabaseZap, FileCode2, HardDriveDownload,
  Menu, FolderOpen, ChevronRight, LogOut, X as CloseIcon, LogIn, Cloud, UserCircle, Settings, Coins
} from 'lucide-react';
import { WALL_THICKNESS_DEFAULT, WALL_HEIGHT_DEFAULT, DEFAULT_PROJECT_SETTINGS_3D, FT_TO_M, PROCEDURAL_TYPOLOGIES, INTERIOR_ELEMENT_PRESETS, normalizeInteriorElement, registerCustomInteriorPresets } from './constants';
import { curveLength as analyticCurveLength, getCurvePoint as analyticGetCurvePoint } from './services/geometry/curveGeometry';
import { finalizeText4dImportHandoff } from './services/text4dImportHandoff';
import { finalizeText4fImportHandoff, isText4fAuthoritativePreview } from './services/text4fImportHandoff';
import { finalizeText4gImportHandoff, isText4gAuthoritativePreview } from './services/text4gImportHandoff';
import { finalizeText4hImportHandoff, isText4hAuthoritativePreview } from './services/text4hImportHandoff';
import { finalizeText4jImportHandoff, isText4jAuthoritativePreview } from './services/text4jImportHandoff';
import type { HubType as AiRenderingHubType } from './src/features/ai-rendering-canvas/types/graph';

const DRAWING_TOOLS: EditorTool[] = ['wall', 'door', 'window', 'wall-opening', 'column', 'stair', 'furniture', 'room', 'gridline', 'dimension', 'line', 'rect', 'arc', 'circle', 'ellipse', 'move', 'copy', 'rotate', 'split', 'floor', 'ceiling', 'railing', 'counter', 'fixture', 'procedural-boundary', 'smart-procedural-boundary', 'auto-procedural-boundary'];
const ELEVATION_DIRECTIONS: ElevationDirection[] = ['N', 'S', 'E', 'W'];
const ELEVATION_CREATE_TOOLS = new Set<EditorTool>(['select', 'pan', 'move', 'copy', 'delete', 'door', 'window', 'wall-opening', 'dimension', 'line', 'rect', 'room', 'furniture', 'fixture', 'counter']);
const ELEVATION_DISABLED_DRAW_TOOLS = new Set<EditorTool>(DRAWING_TOOLS.filter(tool => !ELEVATION_CREATE_TOOLS.has(tool)));

const isElevationDrawingView = (view?: DrawingViewId): view is `elevation-${Lowercase<ElevationDirection>}` =>
  !!view && view !== 'plan' && view.startsWith('elevation-');

const getElevationDirection = (view?: DrawingViewId): ElevationDirection | null => {
  if (!isElevationDrawingView(view)) return null;
  const dir = view.split('-')[1]?.toUpperCase();
  return ELEVATION_DIRECTIONS.includes(dir as ElevationDirection) ? dir as ElevationDirection : null;
};

const getElevationViewId = (direction: ElevationDirection): DrawingViewId =>
  `elevation-${direction.toLowerCase()}` as DrawingViewId;

const getImportedRevitMainCategory = (userCategory?: string): string => {
  const categoryToMain: Record<string, string> = {
    Furniture: '1. Furniture',
    Seating: '1. Furniture',
    Dining: '1. Furniture',
    Kitchen: '2. Kitchen',
    Bathroom: '3. Bathroom',
    Counters: '4. Counters',
    Lighting: '5. Lighting',
    Decor: '6. Decor',
    Doors: '7. Doors',
    Windows: '8. Windows',
    Custom: '9. Custom',
  };
  return categoryToMain[userCategory || 'Custom'] || '9. Custom';
};

const normalizeStoredRevitPresets = (storedPresets: any[]): any[] => {
  const existingClassNames = new Set(
    INTERIOR_ELEMENT_PRESETS.map((preset: any) => preset.classname || preset.id || preset.subType)
      .filter(Boolean)
      .map((name: string) => name.toLowerCase())
  );

  return storedPresets.map((preset) => {
    const looksLikeRevit = preset?.isImportedAsset || preset?.sourceType === 'revit_import' || preset?.bimMetadata;
    if (!looksLikeRevit) return preset;

    const fileName = preset.sourceFileName || preset.bimMetadata?.sourceFileName || preset.bimMetadata?.fileName || `${preset.label || 'Imported_Revit_Asset'}.rfa`;
    const baseClassName = BimService.sanitizeImportedClassName(fileName);
    const existing = new Set(existingClassNames);
    const currentClassName = preset.classname || preset.bimMetadata?.classname;
    if (currentClassName) existing.delete(String(currentClassName).toLowerCase());
    const classname = currentClassName || BimService.makeUniqueClassName(baseClassName, existing);
    existingClassNames.add(classname.toLowerCase());

    const displayName = preset.displayName || preset.label || preset.bimMetadata?.displayName || preset.bimMetadata?.revitFamilyName || classname;
    const userCategory = preset.userCategory || preset.bimMetadata?.userCategory || preset.bimMetadata?.category || 'Custom';
    const metadata = BimService.getPersistentMetadata(BimService.createImportedAssetMetadata({
      fileName,
      fileSize: preset.bimMetadata?.fileSize || 0,
      fileType: preset.bimMetadata?.type || (String(fileName).toLowerCase().endsWith('.rvt') ? 'RVT' : 'RFA'),
      displayName,
      classname,
      userCategory,
      width: preset.width || preset.bimMetadata?.dimensions?.width || 1,
      depth: preset.depth || preset.bimMetadata?.dimensions?.depth || 1,
      height: preset.height || preset.bimMetadata?.dimensions?.height || 0.75,
      revitVersion: preset.bimMetadata?.revitVersion,
      rawBmData: preset.bimMetadata?.rawBmData,
      previewUrl: preset.thumbnail || preset.bimMetadata?.thumbnail || preset.bimMetadata?.previewUrl,
      customMeshData: preset.customMeshData || preset.bimMetadata?.model3D?.customMeshData,
      description: preset.bimMetadata?.description,
    }));

    return {
      ...preset,
      id: preset.assetId || `revit_${classname}`,
      assetId: preset.assetId || `revit_${classname}`,
      label: displayName,
      type: 'furniture',
      subType: classname,
      classname,
      displayName,
      userCategory,
      sourceType: 'revit_import',
      sourceFileType: metadata.sourceFileType,
      sourceFileName: metadata.sourceFileName,
      revitFamilyName: metadata.revitFamilyName,
      revitTypeName: metadata.revitTypeName,
      isImportedAsset: true,
      nativeCatalogAsset: false,
      mainCategory: getImportedRevitMainCategory(userCategory),
      subCategory: 'Imported Revit',
      catalogGroup: 'Interior Elements',
      iconType: 'revit-import',
      model3D: metadata.model3D,
      planView2D: metadata.planView2D,
      elevationViews: metadata.elevationViews,
      thumbnail: metadata.thumbnail || metadata.previewUrl,
      dimensions: metadata.dimensions,
      materials: metadata.materials,
      metadata: metadata.metadata,
      importTimestamp: metadata.importTimestamp,
      importVersion: metadata.importVersion,
      bimMetadata: metadata,
    };
  });
};

type ViewRestrictedAction =
  | 'site-import'
  | 'dxf-import'
  | 'bim-import'
  | 'aps-revit-import'
  | 'vector-dxf-export'
  | 'vector-pdf-export'
  | 'ai-generation'
  | 'urban-generation'
  | 'procedural-boundary'
  | 'smart-procedural-boundary'
  | 'auto-procedural-boundary'
  | 'procedural-regenerate'
  | 'furnish-floor';

const VIEW_RESTRICTED_ACTION_LABELS: Record<ViewRestrictedAction, string> = {
  'site-import': 'Site import',
  'dxf-import': 'DXF import',
  'bim-import': 'BIM Importer',
  'aps-revit-import': 'APS Revit Importer',
  'vector-dxf-export': 'Vector DXF export',
  'vector-pdf-export': 'Vector PDF export',
  'ai-generation': 'AI generation',
  'urban-generation': 'Urban generation',
  'procedural-boundary': 'Procedural Rect',
  'smart-procedural-boundary': 'Smart Procedural',
  'auto-procedural-boundary': 'Auto Procedural',
  'procedural-regenerate': 'Procedural regeneration',
  'furnish-floor': 'Floor furnishing',
};

// View policy: imports, exports, and automation/generation flows stay 2D-only.
// If a future change asks to enable one in 3D, pause and warn the user before changing this list.
const VIEW_POLICY_2D_ONLY_ACTIONS = new Set<ViewRestrictedAction>([
  'site-import',
  'dxf-import',
  'bim-import',
  'aps-revit-import',
  'vector-dxf-export',
  'vector-pdf-export',
  'ai-generation',
  'urban-generation',
  'procedural-boundary',
  'smart-procedural-boundary',
  'auto-procedural-boundary',
  'procedural-regenerate',
  'furnish-floor',
]);

const VIEW_POLICY_2D_ONLY_TOOL_IDS = new Set<EditorTool>([
  'procedural-boundary',
  'smart-procedural-boundary',
  'auto-procedural-boundary',
]);

const VIEW_POLICY_3D_ONLY_TOOL_IDS = new Set<EditorTool>([
  'walk',
  'snap',
]);

const DXF_LENGTH_TYPES: DxfLengthType[] = ['Architectural', 'Decimal', 'Engineering', 'Fractional', 'Scientific'];

const DXF_LENGTH_PRECISION_OPTIONS: Record<DxfLengthType, string[]> = {
  Architectural: [`0'-0"`, `0'-0 1/2"`, `0'-0 1/4"`, `0'-0 1/8"`, `0'-0 1/16"`, `0'-0 1/32"`, `0'-0 1/64"`, `0'-0 1/128"`, `0'-0 1/256"`],
  Decimal: ['0', '0.0', '0.00', '0.000', '0.0000', '0.00000', '0.000000', '0.0000000', '0.00000000'],
  Engineering: [`0'-0"`, `0'-0.0"`, `0'-0.00"`, `0'-0.000"`, `0'-0.0000"`, `0'-0.00000"`, `0'-0.000000"`, `0'-0.0000000"`],
  Fractional: ['0', '0 1/2', '0 1/4', '0 1/8', '0 1/16', '0 1/32', '0 1/64', '0 1/128', '0 1/256'],
  Scientific: ['0E+01', '0.0E+01', '0.00E+01', '0.000E+01', '0.0000E+01', '0.00000E+01', '0.000000E+01', '0.0000000E+01'],
};

const DXF_IMPORT_UNIT_OPTIONS: Array<{ value: Exclude<DxfImportUnit, 'auto'>; label: string }> = [
  { value: 'unitless', label: 'Unitless' },
  { value: 'inches', label: 'Inches' },
  { value: 'feet', label: 'Feet' },
  { value: 'us-survey-feet', label: 'US Survey Feet' },
  { value: 'miles', label: 'Miles' },
  { value: 'millimeters', label: 'Millimeters' },
  { value: 'centimeters', label: 'Centimeters' },
  { value: 'meters', label: 'Meters' },
  { value: 'kilometers', label: 'Kilometers' },
  { value: 'microinches', label: 'Microinches' },
  { value: 'mils', label: 'Mils' },
  { value: 'yards', label: 'Yards' },
  { value: 'angstroms', label: 'Angstroms' },
  { value: 'nanometers', label: 'Nanometers' },
  { value: 'microns', label: 'Microns' },
  { value: 'decimeters', label: 'Decimeters' },
  { value: 'decameters', label: 'Decameters' },
  { value: 'hectometers', label: 'Hectometers' },
  { value: 'gigameters', label: 'Gigameters' },
  { value: 'astronomical-units', label: 'Astronomical' },
  { value: 'light-years', label: 'Light Years' },
  { value: 'parsecs', label: 'Parsecs' },
];

const DXF_LIGHTING_OPTIONS: DxfLightingUnit[] = ['International', 'American'];
const DXF_ANGLE_TYPES: DxfAngleType[] = ['Decimal Degrees', 'Deg/Min/Sec', 'Grads', 'Radians', "Surveyor's Units"];

const DXF_ANGLE_PRECISION_OPTIONS: Record<DxfAngleType, string[]> = {
  'Decimal Degrees': ['0', '0.0', '0.00', '0.000', '0.0000', '0.00000', '0.000000', '0.0000000'],
  'Deg/Min/Sec': ['0d', `0d00'`, `0d00'00"`, `0d00'00.0"`, `0d00'00.00"`, `0d00'00.000"`, `0d00'00.0000"`],
  Grads: ['0g', '0.0g', '0.00g', '0.000g', '0.0000g', '0.00000g', '0.000000g', '0.0000000g'],
  Radians: ['0r', '0.0r', '0.00r', '0.000r', '0.0000r', '0.00000r', '0.000000r', '0.0000000r'],
  "Surveyor's Units": ['N 0d E', `N 0d00' E`, `N 0d00'00" E`, `N 0d00'00.0" E`, `N 0d00'00.00" E`, `N 0d00'00.000" E`, `N 0d00'00.0000" E`],
};

const DEFAULT_DXF_UNIT_SETTINGS: DxfUnitSettings = {
  lengthType: 'Decimal',
  lengthPrecision: '0.00',
  drawingUnit: 'meters',
  insertionUnit: 'meters',
  lighting: 'International',
  angleType: 'Decimal Degrees',
  anglePrecision: '0',
};

interface PendingDxfImport {
  contents: string;
  fileName: string;
}

type DxfReviewMode = 'underlay' | 'smart-2d' | 'smart-3d' | 'ai-gemini' | 'bim-interactive';

interface PendingDxfReview {
  fileName: string;
  result: ReturnType<typeof importDxfToProject>;
  previewUnitSystem: UnitSystem;
}

type Canvas2DFrame = {
  offset: Point;
  zoom: number;
  canvasAngle?: number;
};

const getDxfPreviewUnitSystem = (settings: DxfUnitSettings): UnitSystem => {
  if (settings.lengthType === 'Architectural' || settings.lengthType === 'Engineering') return 'imperial';
  return ['inches', 'feet', 'us-survey-feet', 'miles', 'yards'].includes(settings.drawingUnit) ? 'imperial' : 'metric';
};

export let globalInchesDecimalPlaces = 0;

export const setGlobalInchesDecimalPlaces = (val: number) => {
  globalInchesDecimalPlaces = val;
};

export const formatDimension = (meters: number, system: UnitSystem, precision?: number): string => {
  if (meters === undefined || meters === null || isNaN(meters)) {
    return system === 'metric' ? '0.00m' : `0'-0"`;
  }
  if (system === 'metric') {
    const activePrecision = precision !== undefined ? precision : 2;
    return `${meters.toFixed(activePrecision)}m`;
  } else {
    const activePrecision = precision !== undefined ? precision : globalInchesDecimalPlaces;
    const totalInches = meters * 39.3701;
    let feet = Math.floor(totalInches / 12);
    let inches = totalInches - feet * 12;
    let roundedInches = parseFloat(inches.toFixed(activePrecision));
    if (roundedInches >= 12) {
      feet += 1;
      roundedInches -= 12;
    }
    const inchesStr = activePrecision === 0 ? Math.round(roundedInches).toString() : roundedInches.toFixed(activePrecision);
    return `${feet}'-${inchesStr}"`;
  }
};

export const formatArea = (areaSqMeters: number, system: UnitSystem): string => {
  if (system === 'metric') {
    return `${areaSqMeters.toFixed(1)}m²`;
  } else {
    const areaSqFt = areaSqMeters * 10.76392;
    return `${areaSqFt.toFixed(1)}ft²`;
  }
};

export const generateRoomLabel = (
  name: string,
  widthInMeters: number,
  depthInMeters: number,
  unitSystem: UnitSystem,
  roomNameOnly: boolean,
  showArea?: boolean
): string => {
  if (roomNameOnly) {
    return name;
  }
  const wStr = formatDimension(widthInMeters, unitSystem);
  const dStr = formatDimension(depthInMeters, unitSystem);
  if (showArea) {
    const areaLabel = formatArea(widthInMeters * depthInMeters, unitSystem);
    return `${name}\n${wStr} x ${dStr}\n(${areaLabel})`;
  }
  return `${name}\n${wStr} x ${dStr}`;
};

export const parseDimension = (input: string, system: UnitSystem): number | null => {
  const clean = input.toLowerCase().trim();
  if (!clean) return null;

  if (system === 'metric') {
    if (clean.endsWith('mm')) {
      return parseFloat(clean) / 1000;
    }
    return parseFloat(clean);
  } else {
    const ftInRegex = /^(?:(\d+)(?:'|ft))?\s*-?\s*(?:(\d+(?:\.\d+)?)(?:"|in)?)?$/;
    const match = clean.match(ftInRegex);
    if (match) {
      const feet = parseFloat(match[1] || '0');
      const inches = parseFloat(match[2] || '0');
      const isJustNumber = /^\d+(?:\.\d+)?$/.test(clean);
      const totalInches = isJustNumber ? parseFloat(clean) : (feet * 12 + inches);
      return totalInches / 39.3701;
    }
    return null;
  }
};

const getCurvePoint = analyticGetCurvePoint;

const getElementsBounds = (elements: ArchElement[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const includePoint = (point?: Point | null) => {
    if (!point) return;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };

  const includeElement = (el: ArchElement) => {
    const source = el.wallSource || (['arc', 'circle', 'ellipse'].includes(el.type) || el.isCurved ? el.type : null);
    if (source === 'arc' || source === 'circle' || source === 'ellipse') {
      for (let i = 0; i <= 96; i += 1) includePoint(getCurvePoint(el, i / 96));
    } else {
      includePoint(el.p1);
      includePoint(el.p2);
      includePoint(el.p3);
      includePoint(el.p4);
      includePoint(el.pos);
      includePoint(el.controlPoint);
      includePoint(el.arcCenter);
      includePoint(el.ellipseCenter);
    }
    el.boundary?.forEach(includePoint);
    el.cadElements?.forEach(includeElement);
  };

  elements.forEach(includeElement);
  return Number.isFinite(minX)
    ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, center: { x: 0, y: 0 } };
};

const scaleElementsAround = (elements: ArchElement[], scale: number, center: Point): ArchElement[] => {
  const scalePoint = (point: Point): Point => ({
    x: center.x + (point.x - center.x) * scale,
    y: center.y + (point.y - center.y) * scale,
  });

  return elements.map(el => ({
    ...el,
    p1: el.p1 ? scalePoint(el.p1) : el.p1,
    p2: el.p2 ? scalePoint(el.p2) : el.p2,
    p3: el.p3 ? scalePoint(el.p3) : el.p3,
    p4: el.p4 ? scalePoint(el.p4) : el.p4,
    pos: el.pos ? scalePoint(el.pos) : el.pos,
    controlPoint: el.controlPoint ? scalePoint(el.controlPoint) : el.controlPoint,
    arcCenter: el.arcCenter ? scalePoint(el.arcCenter) : el.arcCenter,
    arcRadius: el.arcRadius !== undefined ? el.arcRadius * scale : el.arcRadius,
    ellipseCenter: el.ellipseCenter ? scalePoint(el.ellipseCenter) : el.ellipseCenter,
    ellipseRadiusX: el.ellipseRadiusX !== undefined ? el.ellipseRadiusX * scale : el.ellipseRadiusX,
    ellipseRadiusY: el.ellipseRadiusY !== undefined ? el.ellipseRadiusY * scale : el.ellipseRadiusY,
    width: el.width !== undefined ? el.width * scale : el.width,
    depth: el.depth !== undefined ? el.depth * scale : el.depth,
    boundary: el.boundary ? el.boundary.map(scalePoint) : el.boundary,
    cadElements: el.cadElements ? scaleElementsAround(el.cadElements, scale, center) : el.cadElements,
  }));
};

const getWallLength = (wall: ArchElement): number => analyticCurveLength(wall, 64);

const isHostedBy = (op: ArchElement, wall: ArchElement): boolean => {
  if (!op.pos || !wall.p1 || !wall.p2) return false;
  if (op.hostWallId && op.hostWallId === wall.id) return true;

  const { x, y } = op.pos;
  const source = wall.wallSource || (wall.isCurved ? wall.type : null);
  
  if (source === 'circle' || source === 'ellipse' || source === 'arc') {
    // For curved walls, find nearest point on curve by sampling
    let minDistSq = Infinity;
    let bestT = 0;
    const samples = 80;
    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const pt = getCurvePoint(wall, t);
        if (!pt) continue;
        const d2 = (x - pt.x)**2 + (y - pt.y)**2;
        if (d2 < minDistSq) {
            minDistSq = d2;
            bestT = t;
        }
    }
    
    if (minDistSq < 0.25) {
        op.hostWallId = wall.id;
        op.hostT = bestT;
        return true;
    }
    return false;
  }

  // Linear wall logic
  const dx = wall.p2.x - wall.p1.x;
  const dy = wall.p2.y - wall.p1.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 0.0001) return false;

  const t = ((x - wall.p1.x) * dx + (y - wall.p1.y) * dy) / l2;
  if (t < 0 || t > 1) return false;

  const px = wall.p1.x + t * dx;
  const py = wall.p1.y + t * dy;
  const distSq = (x - px) ** 2 + (y - py) ** 2;

  if (distSq < 0.25) {
    op.hostWallId = wall.id;
    op.hostT = t;
    return true;
  }

  return false;
};

const updateHostedOpenings = (
  wall: ArchElement,
  elements: ArchElement[]
): ArchElement[] => {
  if (!wall.p1 || !wall.p2) return elements;

  return elements.map(el => {
    if (
      (el.type === 'door' || el.type === 'window' || el.type === 'wall-opening') &&
      el.hostWallId === wall.id &&
      typeof el.hostT === 'number'
    ) {
      if (
        wall.isCurved ||
        wall.wallSource === 'arc' ||
        wall.wallSource === 'circle' ||
        wall.wallSource === 'ellipse'
      ) {
        // Improved logic: Position as a chord between two points on the curve
        const width = el.width || 0.8;
        
        // Estimate local speed (dS/dt) at current hostT to find parameter width dt
        const eps = 0.001;
        const pMid = getCurvePoint(wall, el.hostT);
        if (!pMid) return el;
        
        const pNext = getCurvePoint(wall, el.hostT + eps) || pMid;
        const pPrev = getCurvePoint(wall, el.hostT - eps) || pMid;
        const dS = Math.sqrt((pNext.x - pPrev.x)**2 + (pNext.y - pPrev.y)**2);
        const speed = dS / (eps * 2);
        
        if (speed < 0.0001) return el;
        
        let dt = width / speed;
        
        // One iteration of refinement for perfect chord alignment
        let p1 = getCurvePoint(wall, el.hostT - dt / 2);
        let p2 = getCurvePoint(wall, el.hostT + dt / 2);
        
        if (p1 && p2) {
          const chordLen = Math.sqrt((p2.x - p1.x)**2 + (p2.y - p1.y)**2);
          if (chordLen > 0.01) {
            dt *= (width / chordLen);
            p1 = getCurvePoint(wall, el.hostT - dt / 2) || p1;
            p2 = getCurvePoint(wall, el.hostT + dt / 2) || p2;
          }
        }
        
        if (p1 && p2) {
          const rotation = Math.atan2(p2.y - p1.y, p2.x - p1.x) * (180 / Math.PI);
          return {
            ...el,
            pos: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
            rotation
          };
        }

        // Fallback to tangent if chord calculation fails (e.g. invalid points)
        const angle = Math.atan2(pNext.y - pMid.y, pNext.x - pMid.x) * (180 / Math.PI);
        return {
          ...el,
          pos: { x: pMid.x, y: pMid.y },
          rotation: angle
        };
      }
      const dx = wall.p2.x - wall.p1.x;
      const dy = wall.p2.y - wall.p1.y;
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      return {
        ...el,
        pos: {
          x: wall.p1.x + dx * el.hostT,
          y: wall.p1.y + dy * el.hostT
        },
        rotation: angle
      };
    }
    return el;
  });
};

const DEFAULT_LAYERS = [
  { name: '0', visible: true, locked: false },
  { name: 'WALLS', visible: true, locked: false },
  { name: 'DOORS', visible: true, locked: false },
  { name: 'WINDOWS', visible: true, locked: false },
  { name: 'OPENINGS', visible: true, locked: false },
  { name: 'COLUMNS', visible: true, locked: false },
  { name: 'STAIRS', visible: true, locked: false },
  { name: 'RAILINGS', visible: true, locked: false },
  { name: 'FLOORS', visible: true, locked: false },
  { name: 'CEILINGS', visible: true, locked: false },
  { name: 'COUNTERS', visible: true, locked: false },
  { name: 'FIXTURES', visible: true, locked: false },
  { name: 'FURNITURE', visible: true, locked: false },
  { name: 'GRIDLINES', visible: true, locked: false },
  { name: 'DIMENSIONS', visible: true, locked: false },
  { name: 'ROOMS', visible: true, locked: false },
  { name: 'TEXT', visible: true, locked: false },
  { name: 'SHAPES', visible: true, locked: false },
  { name: 'CONSTRUCTION', visible: true, locked: false },
];

const LEGACY_LAYER_NAMES: Record<string, string> = {
  STAIRCASE: 'STAIRS',
  RAILING: 'RAILINGS',
  FLOORING: 'FLOORS',
  CEILING: 'CEILINGS',
};

const normalizeLayerName = (name?: string): string => {
  const value = name?.trim() || '0';
  return LEGACY_LAYER_NAMES[value.toUpperCase()] || value;
};

const getElementDefaultLayer = (type: string): string => {
  if (['line', 'rect', 'arc', 'ellipse', 'circle', 'rectangle'].includes(type)) return 'SHAPES';
  if (type === 'wall') return 'WALLS';
  if (type === 'door') return 'DOORS';
  if (type === 'window') return 'WINDOWS';
  if (type === 'wall-opening') return 'OPENINGS';
  if (type === 'column') return 'COLUMNS';
  if (type === 'stair') return 'STAIRS';
  if (type === 'railing') return 'RAILINGS';
  if (type === 'ceiling') return 'CEILINGS';
  if (type === 'floor') return 'FLOORS';
  if (type === 'furniture') return 'FURNITURE';
  if (type === 'fixture') return 'FIXTURES';
  if (type === 'counter') return 'COUNTERS';
  if (type === 'gridline') return 'GRIDLINES';
  if (type === 'dimension') return 'DIMENSIONS';
  if (type === 'label') return 'TEXT';
  if (type === 'room') return 'ROOMS';
  if (type === 'elevation-marker') return 'TEXT';
  if (type === 'procedural-boundary' || type === 'smart-procedural-boundary' || type === 'auto-procedural-boundary') return 'CONSTRUCTION';
  return '0';
};

const ensureProjectLayers = (proj: Project): Project => {
  if (!proj) return proj;
  const sourceLayers = proj.layers && proj.layers.length > 0 ? proj.layers : [];
  const updatedLayers = DEFAULT_LAYERS.map(defaultLayer => {
    const existing = sourceLayers.find(layer => normalizeLayerName(layer.name).toUpperCase() === defaultLayer.name);
    return existing ? { ...existing, name: defaultLayer.name } : { ...defaultLayer };
  });
  sourceLayers.forEach(layer => {
    const name = normalizeLayerName(layer.name);
    if (!updatedLayers.some(existing => existing.name.toUpperCase() === name.toUpperCase())) {
      updatedLayers.push({ ...layer, name });
    }
  });

  const updatedElements = proj.elements.map(el => {
    const normalizedLayer = normalizeLayerName(el.layer);
    const annotationMovedFromZero = normalizedLayer === '0' && ['gridline', 'dimension', 'room', 'elevation-marker'].includes(el.type);
    const layer = !el.layer || annotationMovedFromZero ? getElementDefaultLayer(el.type) : normalizedLayer;
    return layer === el.layer ? el : { ...el, layer };
  });

  return {
    ...proj,
    layers: updatedLayers,
    elements: updatedElements
  };
};

const normalizeImportedProjectJson = (value: unknown, fallbackName = 'Imported Project'): Project => {
  if (!value || typeof value !== 'object') {
    throw new Error('The selected file does not contain a project object.');
  }

  const raw = value as Partial<Project>;
  if (!Array.isArray(raw.elements)) {
    throw new Error('The selected JSON is missing a valid elements array.');
  }

  const fallbackLevelId = crypto.randomUUID();
  const levels = Array.isArray(raw.levels) && raw.levels.length > 0
    ? raw.levels.map((level, index) => ({
        id: level?.id || (index === 0 ? fallbackLevelId : crypto.randomUUID()),
        name: level?.name || `Level ${index + 1}`,
        zElevation: Number.isFinite(level?.zElevation) ? level!.zElevation : 0,
        height: Number.isFinite(level?.height) ? level!.height : WALL_HEIGHT_DEFAULT,
        order: Number.isFinite(level?.order) ? level!.order : index,
        metadata: level?.metadata,
      }))
    : [{ id: fallbackLevelId, name: 'Level 1', zElevation: 0, height: WALL_HEIGHT_DEFAULT, order: 0 }];

  const primaryLevelId = levels[0].id;
  const levelIds = new Set(levels.map(level => level.id));
  const elements = raw.elements
    .filter((element): element is ArchElement => !!element && typeof element === 'object' && typeof element.type === 'string')
    .map(element => ({
      ...element,
      id: element.id || crypto.randomUUID(),
      levelId: element.levelId && levelIds.has(element.levelId) ? element.levelId : primaryLevelId,
    }));

  if (elements.length !== raw.elements.length) {
    throw new Error('The selected JSON contains project elements with invalid structure.');
  }

  const importedProject: Project = {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : fallbackName,
    mode: raw.mode === 'urban' ? 'urban' : 'floorplan',
    levels,
    elements,
    viewBox: {
      width: Number.isFinite(raw.viewBox?.width) ? raw.viewBox!.width : 100,
      height: Number.isFinite(raw.viewBox?.height) ? raw.viewBox!.height : 100,
    },
    settings3D: {
      ...DEFAULT_PROJECT_SETTINGS_3D,
      ...(raw.settings3D || {}),
    },
    metadata: raw.metadata,
    urbanSettings: raw.urbanSettings,
    siteMap: raw.siteMap,
    location: raw.location,
    terrain: raw.terrain,
    layers: raw.layers,
  };

  return ensureProjectLayers(importedProject);
};

const App: React.FC = () => {
  const [project, setProjectRaw] = useState<Project | null>(null);
  const setProject = (p: Project | null | ((prev: Project | null) => Project | null)) => {
    if (typeof p === 'function') {
      setProjectRaw(prev => {
        const next = p(prev);
        return next ? ensureProjectLayers(next) : null;
      });
    } else {
      setProjectRaw(p ? ensureProjectLayers(p) : null);
    }
  };
  const [isProcessing, setIsProcessing] = useState(false);
  const [history, setHistory] = useState<Project[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showSaveFeedback, setShowSaveFeedback] = useState(false);
  const [isGenerativeWizardOpen, setIsGenerativeWizardOpen] = useState(false);
  const [snapPreviewImage, setSnapPreviewImage] = useState<string | null>(null);
  const [pendingSnapshots, setPendingSnapshots] = useState<{url: string, name: string}[]>([]);
  const [generativeInitialMode, setGenerativeInitialMode] = useState<GenerativeWizardMode>('chat');
  const [generativeInitialHub, setGenerativeInitialHub] = useState<AiRenderingHubType>('image_studio');
  const [generativeInitialText4hImageTest, setGenerativeInitialText4hImageTest] = useState(false);
  const [isUrbanWizardOpen, setIsUrbanWizardOpen] = useState(false);
  const [isSiteImportWizardOpen, setIsSiteImportWizardOpen] = useState(false);
  const [isPdfExportOpen, setIsPdfExportOpen] = useState(false);
  const [isProceduralWizardOpen, setIsProceduralWizardOpen] = useState(false);
  const [isImportExportMenuOpen, setIsImportExportMenuOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<'import' | 'export' | null>(null);
  const mainMenuRef = useRef<HTMLDivElement>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isProjectsPanelOpen, setIsProjectsPanelOpen] = useState(false);
  const [isAccountPanelOpen, setIsAccountPanelOpen] = useState(false);
  const [isTokensPanelOpen, setIsTokensPanelOpen] = useState(false);
  const [accountBalance, setAccountBalance] = useState<AccountBalance>(EMPTY_BALANCE);
  // Set when an action was refused for want of tokens, so the panel can say which one.
  const [tokenShortfall, setTokenShortfall] = useState<{ required: number; balance: number } | null>(null);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  // Which saved document the open project belongs to. Without this, every save created a
  // duplicate instead of updating the project the user already had open.
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured) return;
    // Finishes a Google sign-in that fell back to the redirect flow because the popup was blocked.
    completeGoogleRedirectSignIn().catch(err => console.warn('Google redirect sign-in failed:', err));
    const unsubscribe = watchAuthState(setCurrentUser);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isImportExportMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mainMenuRef.current && !mainMenuRef.current.contains(e.target as Node)) {
        setIsImportExportMenuOpen(false);
        setActiveSubmenu(null);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [isImportExportMenuOpen]);

  // Every /api route now requires a signed-in caller. Rather than adding a guard to each
  // wizard's Generate button, the fetch interceptor tells us when a call was rejected and
  // we surface the sign-in modal the app already has.
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    const handleAuthRequired = () => setIsAuthModalOpen(true);
    window.addEventListener(API_AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => window.removeEventListener(API_AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);

  // Same idea for running out of tokens (402): open the tokens panel with the shortfall
  // spelled out, rather than letting the wizard fail with an opaque error.
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    const handleTokensRequired = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      setTokenShortfall({
        required: Number(detail.required ?? 0),
        balance: Number(detail.balance ?? 0),
      });
      setIsTokensPanelOpen(true);
    };
    window.addEventListener(TOKENS_REQUIRED_EVENT, handleTokensRequired);
    return () => window.removeEventListener(TOKENS_REQUIRED_EVENT, handleTokensRequired);
  }, []);

  // Live balance, straight from Firestore. The security rules make entitlements/{uid}
  // readable by its owner and writable by nobody, so this updates the moment a charge
  // lands without any polling.
  useEffect(() => {
    if (!isFirebaseConfigured || !currentUser) {
      setAccountBalance(EMPTY_BALANCE);
      return;
    }
    return watchAccountBalance(currentUser.uid, setAccountBalance);
  }, [currentUser]);

  // Coming back from a successful Stripe Checkout: show the new balance and drop the query
  // string so a refresh doesn't reopen the panel.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') !== 'success') return;
    setIsTokensPanelOpen(true);
    setTokenShortfall(null);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    if (!isAccountMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setIsAccountMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [isAccountMenuOpen]);

  // Signing out must not leave the previous user's saved-project id attached to whatever
  // the next person opens.
  useEffect(() => {
    if (!currentUser) setCurrentProjectId(null);
  }, [currentUser]);

  useEffect(() => {
    const handleSnap = (e: Event) => {
      const url = (e as CustomEvent).detail.dataUrl;
      setSnapPreviewImage(url);
    };
    window.addEventListener('3d-snap-taken', handleSnap);
    return () => window.removeEventListener('3d-snap-taken', handleSnap);
  }, []);

  const [isSmartProceduralWizardOpen, setIsSmartProceduralWizardOpen] = useState(false);
  const [isBlockEditorOpen, setIsBlockEditorOpen] = useState(false);
  const [pendingDxfImport, setPendingDxfImport] = useState<PendingDxfImport | null>(null);
  const [pendingDxfReview, setPendingDxfReview] = useState<PendingDxfReview | null>(null);
  const [isRevitWizardOpen, setIsRevitWizardOpen] = useState(false);
  const [pendingBimReview, setPendingBimReview] = useState<any | null>(null);
  const [isBimImportWizardOpen, setIsBimImportWizardOpen] = useState(false);
  const [isApsRevitImportDialogOpen, setIsApsRevitImportDialogOpen] = useState(false);
  const [isBimExportDialogOpen, setIsBimExportDialogOpen] = useState(false);
  const [isRevitExportDialogOpen, setIsRevitExportDialogOpen] = useState(false);
  const [pendingBimImportReview, setPendingBimImportReview] = useState<BimImportSession | null>(null);
  const [customRevitPresets, setCustomRevitPresets] = useState<any[]>(() => {
    try {
      const stored = localStorage.getItem('archai_custom_revit_presets');
      return stored ? normalizeStoredRevitPresets(JSON.parse(stored)) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (customRevitPresets.length > 0) {
      registerCustomInteriorPresets(customRevitPresets);
    }
  }, [customRevitPresets]);
  const [pendingConvert3dId, setPendingConvert3dId] = useState<string | null>(null);
  const [dxfUnitSettings, setDxfUnitSettings] = useState<DxfUnitSettings>(DEFAULT_DXF_UNIT_SETTINGS);
  const [dxfImportSummary, setDxfImportSummary] = useState<any | null>(null);
  const [proceduralWizardData, setProceduralWizardData] = useState<{ hostId: string, boundary: Point[] } | null>(null);
  const [smartProceduralWizardData, setSmartProceduralWizardData] = useState<{ hostId: string, boundary: Point[] } | null>(null);
  const [isSiteMapPanelOpen, setIsSiteMapPanelOpen] = useState(false);
  const [showMirrorOptions, setShowMirrorOptions] = useState(false);
  const [activeProceduralConfig, setActiveProceduralConfig] = useState<ProceduralConfig | null>(null);
  const [placingImportedElements, setPlacingImportedElements] = useState<ArchElement[] | null>(null);
  const [placingImportedLevels, setPlacingImportedLevels] = useState<Level[] | null>(null);
  const [pendingProceduralTool, setPendingProceduralTool] = useState<EditorTool | null>(null);
  const [layoutWarnings, setLayoutWarnings] = useState<string[]>([]);
  
  const [toolboxPos, setToolboxPos] = useState<DockPosition>('left');
  const [drawBarPos, setToolboxDrawBarPos] = useState<DockPosition>('top');
  const [snapBarPos, setToolboxSnapBarPos] = useState<DockPosition>('bottom');

  const toolBeforeSpace = useRef<EditorTool | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const dxfFileInputRef = useRef<HTMLInputElement>(null);
  const projectJsonFileInputRef = useRef<HTMLInputElement>(null);
  const cmdBuffer = useRef<string>("");
  const cmdTimeout = useRef<number | null>(null);
  const viewportFramesRef = useRef<{ [viewId: string]: View3DCameraFrame | null }>({
    '3D': null,
  });
  const canvas2DFramesRef = useRef<Record<DrawingViewId, Canvas2DFrame | null>>({
    plan: null,
    'elevation-n': null,
    'elevation-s': null,
    'elevation-e': null,
    'elevation-w': null,
  });

  const [editorState, setEditorState] = useState<EditorState>({
    zoom: 15,
    offset: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    selectedIds: [],
    isPanning: false,
    activeTool: 'select',
    activeLevelId: 'level-1', // Default
    isGridVisible: true,
    isSnapEnabled: false,
    isWallMode: false,
    unitSystem: 'metric',
    viewMode: '2D',
    drawingView: 'plan',
    isOrthoEnabled: false,
    isEndpointSnap: true,
    isMidpointSnap: true,
    isIntersectionSnap: true,
    isPointAlignmentSnap: true,
    isAngularAlignmentSnap: true,
    isSiteMapVisible: true,
    canvasAngle: 0,
    lastActiveTool: 'line',
    lastIsWallMode: false,
  });
  const [isParallel3D, setIsParallel3D] = useState(false);

  const navigateBackOneStep = useCallback(() => {
    const backDetail: { priority: number; action?: () => void } = { priority: 0 };
    const backRequest = new CustomEvent('archai:navigate-back', { cancelable: true, detail: backDetail });
    window.dispatchEvent(backRequest);
    if (backDetail.action) {
      backDetail.action();
      return;
    }
    if (backRequest.defaultPrevented) return;

    if (showMirrorOptions) return setShowMirrorOptions(false);
    if (isImportExportMenuOpen) return setIsImportExportMenuOpen(false);
    if (pendingDxfImport) return setPendingDxfImport(null);
    if (pendingConvert3dId) return setPendingConvert3dId(null);
    if (isPdfExportOpen) return setIsPdfExportOpen(false);
    if (isAuthModalOpen) return setIsAuthModalOpen(false);
    if (isTokensPanelOpen) return setIsTokensPanelOpen(false);
    if (isAccountPanelOpen) return setIsAccountPanelOpen(false);
    if (isProjectsPanelOpen) return setIsProjectsPanelOpen(false);
    if (isSiteImportWizardOpen) return setIsSiteImportWizardOpen(false);
    if (isSiteMapPanelOpen) return setIsSiteMapPanelOpen(false);
    if (isRevitExportDialogOpen) return setIsRevitExportDialogOpen(false);
    if (isBimExportDialogOpen) return setIsBimExportDialogOpen(false);
    if (isApsRevitImportDialogOpen) return setIsApsRevitImportDialogOpen(false);
    if (isBimImportWizardOpen) return setIsBimImportWizardOpen(false);
    if (isRevitWizardOpen) return setIsRevitWizardOpen(false);
    if (isBlockEditorOpen) return setIsBlockEditorOpen(false);
    if (isSmartProceduralWizardOpen) return setIsSmartProceduralWizardOpen(false);
    if (isProceduralWizardOpen) return setIsProceduralWizardOpen(false);
    if (isUrbanWizardOpen) return setIsUrbanWizardOpen(false);
    if (isGenerativeWizardOpen) {
      setIsGenerativeWizardOpen(false);
      setPendingDxfReview(null);
      setPendingBimImportReview(null);
      setPendingBimReview(null);
      return;
    }
    if (editorState.activeTool === 'auto-procedural-boundary') {
      setEditorState(state => ({ ...state, activeTool: 'select' }));
      return;
    }
    if (placingImportedElements) {
      setPlacingImportedElements(null);
      setPlacingImportedLevels(null);
      return;
    }
    setProjectRaw(null);
  }, [
    showMirrorOptions, isImportExportMenuOpen, pendingDxfImport, pendingConvert3dId,
    isPdfExportOpen, isSiteImportWizardOpen, isSiteMapPanelOpen, isRevitExportDialogOpen,
    isBimExportDialogOpen, isApsRevitImportDialogOpen, isBimImportWizardOpen, isRevitWizardOpen,
    isBlockEditorOpen, isSmartProceduralWizardOpen, isProceduralWizardOpen, isUrbanWizardOpen,
    isGenerativeWizardOpen, editorState.activeTool, placingImportedElements,
  ]);

  const hasOpenNavigationLayer = Boolean(
    showMirrorOptions || isImportExportMenuOpen || pendingDxfImport || pendingConvert3dId ||
    isPdfExportOpen || isSiteImportWizardOpen || isSiteMapPanelOpen || isRevitExportDialogOpen ||
    isBimExportDialogOpen || isApsRevitImportDialogOpen || isBimImportWizardOpen || isRevitWizardOpen ||
    isBlockEditorOpen || isSmartProceduralWizardOpen || isProceduralWizardOpen || isUrbanWizardOpen ||
    isGenerativeWizardOpen || editorState.activeTool === 'auto-procedural-boundary' || placingImportedElements
  );

  useEffect(() => {
    if (!hasOpenNavigationLayer) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      navigateBackOneStep();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [hasOpenNavigationLayer, navigateBackOneStep]);

  // Ensure activeLevelId is valid
  useEffect(() => {
    if (project && project.levels.length > 0) {
        if (!project.levels.find(l => l.id === editorState.activeLevelId)) {
            setEditorState(s => ({ ...s, activeLevelId: project.levels[0].id }));
        }
    }
  }, [project, editorState.activeLevelId]);

  // Synchronize global imperial/inches decimal places setting
  useEffect(() => {
    if (project) {
      const places = project.settings3D?.inchesDecimalPlaces ?? 0;
      setGlobalInchesDecimalPlaces(places);
    }
  }, [project, project?.settings3D?.inchesDecimalPlaces]);

  const pushHistory = useCallback((proj: Project) => {
    const cleanProj = ensureProjectLayers(proj);
    const projCopy = JSON.parse(JSON.stringify(cleanProj));
    if (historyIndex >= 0 && historyIndex < history.length) {
      if (JSON.stringify(projCopy) === JSON.stringify(history[historyIndex])) {
        return;
      }
    }
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(projCopy);
    if (newHistory.length > 50) newHistory.shift();
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }, [history, historyIndex]);

  const onSelectionChange = useCallback((ids: string[]) => {
    if (!project) {
        setEditorState(s => ({ ...s, selectedIds: ids }));
        return;
    }

    const expandedIds = new Set<string>();

    const getRootId = (id: string): string => {
        const el = project.elements.find(e => e.id === id);
        if (el?.groupId) return getRootId(el.groupId);
        return id;
    };

    const addRecursive = (id: string) => {
        if (expandedIds.has(id)) return;
        expandedIds.add(id);
        project.elements.forEach(el => {
            if (el.groupId === id) addRecursive(el.id);
        });
    };

    ids.forEach(id => {
        const rootId = getRootId(id);
        addRecursive(rootId);
    });

    setEditorState(s => ({ ...s, selectedIds: Array.from(expandedIds) }));
  }, [project]);

  const onGroup = useCallback(() => {
    if (!project || editorState.selectedIds.length < 1) return;
    
    // Find top-level elements of the current selection (those whose groupId is NOT in selection)
    const topLevelIds = editorState.selectedIds.filter(id => {
      const el = project.elements.find(e => e.id === id);
      return !el?.groupId || !editorState.selectedIds.includes(el.groupId);
    });

    if (topLevelIds.length < 1) return;

    const newGroupId = crypto.randomUUID();
    const newGroupElement: ArchElement = {
      id: newGroupId,
      type: 'group',
      levelId: editorState.activeLevelId,
    };

    const updatedElements = project.elements.map(el => {
      if (topLevelIds.includes(el.id)) {
        return { ...el, groupId: newGroupId };
      }
      return el;
    });

    const nextProject = { ...project, elements: [...updatedElements, newGroupElement] };
    setProject(nextProject);
    pushHistory(nextProject);
    onSelectionChange([newGroupId]); // Select the new group
  }, [project, editorState.selectedIds, editorState.activeLevelId, pushHistory, onSelectionChange]);

  const onUngroup = useCallback(() => {
    if (!project || editorState.selectedIds.length === 0) return;

    // Find top-level elements in selection
    const topLevelElements = project.elements.filter(el => 
      editorState.selectedIds.includes(el.id) && (!el.groupId || !editorState.selectedIds.includes(el.groupId))
    );

    // We only ungroup if exactly one top-level item is selected and it acts as a group
    if (topLevelElements.length !== 1) return;
    
    const groupToUngroup = topLevelElements[0];
    const groupToUngroupId = groupToUngroup.id;

    // It's a group if it's explicitly type 'group' or if it has members
    const hasMembers = project.elements.some(el => el.groupId === groupToUngroupId);
    if (groupToUngroup.type !== 'group' && !hasMembers) return;

    // 1. Remove the group element if it exists
    let updatedElements = project.elements.filter(el => el.id !== groupToUngroupId);

    // 2. Clear groupId for its immediate children
    const childIds: string[] = [];
    updatedElements = updatedElements.map(el => {
      if (el.groupId === groupToUngroupId) {
        childIds.push(el.id);
        const { groupId, ...rest } = el;
        return rest as ArchElement;
      }
      return el;
    });

    const nextProject = { ...project, elements: updatedElements };
    setProject(nextProject);
    pushHistory(nextProject);
    
    // Select the immediate children after ungrouping
    onSelectionChange(childIds);
  }, [project, editorState.selectedIds, pushHistory, onSelectionChange]);

  const validateOpenings = useCallback((elements: ArchElement[]): ArchElement[] => {
    const wallMap = new Map<string, ArchElement>();
    const openingsByWall = new Map<string, ArchElement[]>();
    const others: ArchElement[] = [];

    elements.forEach(element => {
      if (element.type === 'wall') wallMap.set(element.id, element);
    });
    const isMandatoryExteriorEntry = (element: ArchElement) =>
      element.type === 'door' &&
      (element.metadata?.text3MandatoryExteriorEntry === true || element.metadata?.text4MandatoryExteriorEntry === true);
    const rehostMandatoryEntry = (door: ArchElement): ArchElement | undefined => {
      if (!door.pos) return undefined;
      let best: { wall: ArchElement; t: number; pos: Point; distance: number } | undefined;
      wallMap.forEach(wall => {
        if (!wall.p1 || !wall.p2 || (wall.thickness || 0) < 0.2) return;
        const dx = wall.p2.x - wall.p1.x, dy = wall.p2.y - wall.p1.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq < 0.001) return;
        const t = Math.max(0, Math.min(1, ((door.pos!.x - wall.p1.x) * dx + (door.pos!.y - wall.p1.y) * dy) / lengthSq));
        const pos = { x: wall.p1.x + dx * t, y: wall.p1.y + dy * t };
        const distance = Math.hypot(door.pos!.x - pos.x, door.pos!.y - pos.y);
        if (distance <= 0.4 && (!best || distance < best.distance)) best = { wall, t, pos, distance };
      });
      return best ? {
        ...door,
        hostWallId: best.wall.id,
        hostT: best.t,
        pos: best.pos,
        rotation: Math.atan2(best.wall.p2!.y - best.wall.p1!.y, best.wall.p2!.x - best.wall.p1!.x) * 180 / Math.PI,
      } : undefined;
    };

    elements.forEach(e => {
      if (e.type === 'wall') {
        others.push(e);
      } else if (e.type === 'door' || e.type === 'window' || e.type === 'wall-opening') {
        let opening = e;
        const currentHost = opening.hostWallId ? wallMap.get(opening.hostWallId) : undefined;
        if (isMandatoryExteriorEntry(opening) && (!currentHost || (currentHost.thickness || 0) < 0.2)) {
          opening = rehostMandatoryEntry(opening) || opening;
        }
        if (opening.hostWallId && wallMap.has(opening.hostWallId)) {
          if (!openingsByWall.has(opening.hostWallId)) openingsByWall.set(opening.hostWallId, []);
          openingsByWall.get(opening.hostWallId)!.push(opening);
        } else {
          others.push(opening);
        }
      } else {
        others.push(e);
      }
    });

    const validOpenings: ArchElement[] = [];
    const EDGE_MARGIN = 0.0762; // 3 inches

    openingsByWall.forEach((ops, wallId) => {
      const wall = wallMap.get(wallId);
      if (!wall || !wall.p1 || !wall.p2) return;

      const L = getWallLength(wall);
      if (L <= 0) return;

      const closed = wall.wallSource === 'circle' || wall.wallSource === 'ellipse' || (wall.p1.x === wall.p2.x && wall.p1.y === wall.p2.y && wall.isCurved);

      // Sort by hostT
      ops.sort((a, b) => Number(isMandatoryExteriorEntry(b)) - Number(isMandatoryExteriorEntry(a)) || (a.hostT || 0) - (b.hostT || 0));

      let currentMinT = closed ? 0 : EDGE_MARGIN / L;
      
      for (const op of ops) {
        let width = op.width || 1;
        
        // If opening is larger than the wall itself minus margins, drop it
        if (!closed && width + 2 * EDGE_MARGIN > L) {
          if (!isMandatoryExteriorEntry(op)) continue;
          width = Math.max(0.3, L - 2 * EDGE_MARGIN);
        }

        const halfT = width / (2 * L);
        let t = op.hostT !== undefined ? op.hostT : 0.5;
        
        // Ensure it doesn't overlap previous opening or start edge
        if (!closed && t - halfT < currentMinT) {
          t = currentMinT + halfT;
        }

        // Check if it crosses the end edge
        if (!closed && t + halfT > 1 - (EDGE_MARGIN / L)) {
          // Push back
          t = 1 - (EDGE_MARGIN / L) - halfT;
          if (t - halfT < currentMinT - 0.0001) {
            // Cannot fit on the wall without overlapping
            continue; 
          }
        }

        // Update currentMinT for the NEXT opening
        currentMinT = t + halfT;

        // Apply curved or linear pos update
        let updatedOp = { ...op, width, hostT: t };
        
        if (wall.isCurved || wall.wallSource === 'arc' || wall.wallSource === 'circle' || wall.wallSource === 'ellipse') {
          const eps = 0.001;
          const pMid = getCurvePoint(wall, t);
          if (!pMid) continue;
          const pNext = getCurvePoint(wall, t + eps) || pMid;
          const pPrev = getCurvePoint(wall, t - eps) || pMid;
          const dS = Math.sqrt((pNext.x - pPrev.x)**2 + (pNext.y - pPrev.y)**2);
          const speed = dS / (eps * 2);
          if (speed < 0.0001) continue;
          let dt = width / speed;
          let p1 = getCurvePoint(wall, t - dt / 2);
          let p2 = getCurvePoint(wall, t + dt / 2);
          if (p1 && p2) {
            const chordLen = Math.sqrt((p2.x - p1.x)**2 + (p2.y - p1.y)**2);
            if (chordLen > 0.01) {
              dt *= (width / chordLen);
              p1 = getCurvePoint(wall, t - dt / 2) || p1;
              p2 = getCurvePoint(wall, t + dt / 2) || p2;
            }
          }
          if (p1 && p2) {
            const rotation = Math.atan2(p2.y - p1.y, p2.x - p1.x) * (180 / Math.PI);
            updatedOp.pos = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            updatedOp.rotation = rotation;
          } else {
            const angle = Math.atan2(pNext.y - pMid.y, pNext.x - pMid.x) * (180 / Math.PI);
            updatedOp.pos = { x: pMid.x, y: pMid.y };
            updatedOp.rotation = angle;
          }
        } else {
          const dx = wall.p2.x - wall.p1.x;
          const dy = wall.p2.y - wall.p1.y;
          const angle = Math.atan2(dy, dx) * (180 / Math.PI);
          updatedOp.pos = { x: wall.p1.x + dx * t, y: wall.p1.y + dy * t };
          updatedOp.rotation = angle;
        }

        validOpenings.push(updatedOp);
      }
    });

    return [...others, ...validOpenings];
  }, [customRevitPresets]);

  const require2DAction = useCallback((action: ViewRestrictedAction) => {
    const isPlanView = editorState.viewMode === '2D' && (editorState.drawingView || 'plan') === 'plan';
    const isAny2DDrawingView = editorState.viewMode === '2D';
    if (action === 'vector-pdf-export' && isAny2DDrawingView) return true;
    if (isPlanView || !VIEW_POLICY_2D_ONLY_ACTIONS.has(action)) return true;
    alert(`${VIEW_RESTRICTED_ACTION_LABELS[action]} is available in 2D Plan only. Switch to 2D Plan before using it.`);
    return false;
  }, [editorState.viewMode, editorState.drawingView]);

  const run2DOnlyAction = useCallback((action: ViewRestrictedAction, callback: () => void) => {
    if (!require2DAction(action)) return;
    callback();
  }, [require2DAction]);

  const handleToolSelect = useCallback((tool: EditorTool, preset?: any, forceWallMode?: boolean) => {
    // Only open the wizard if the procedural tool is NOT already active 
    // This prevents re-opening the wizard when clicking on the canvas or if the tool is restored (e.g. from Space bar)
    if (tool === 'procedural-boundary') {
      if (!require2DAction('procedural-boundary')) return;
      if (editorState.activeTool !== tool) {
        setPendingProceduralTool(tool);
        setProceduralWizardData(null); // Clear data so it knows it's a new drawing
        setIsProceduralWizardOpen(true);
        return;
      }
    }

    if (tool === 'smart-procedural-boundary') {
      if (!require2DAction('smart-procedural-boundary')) return;
      if (editorState.activeTool !== tool) {
        setPendingProceduralTool(tool);
        setSmartProceduralWizardData(null); // Clear data so it knows it's a new drawing
        setIsSmartProceduralWizardOpen(true);
        return;
      }
    }

    if (tool === 'auto-procedural-boundary') {
      if (!require2DAction('auto-procedural-boundary')) return;
      setGenerativeInitialMode('auto-procedural');
      setIsGenerativeWizardOpen(true);
      setEditorState(s => ({ ...s, activeTool: 'select', selectedIds: [] }));
      return;
    }

    if (tool === 'snap') {
      window.dispatchEvent(new CustomEvent('take-3d-snap'));
      return;
    }

    if (editorState.viewMode === '2D' && isElevationDrawingView(editorState.drawingView) && !ELEVATION_CREATE_TOOLS.has(tool)) {
      alert('That tool is available in 2D Plan only. Elevation views support selection, move/copy, openings, dimensions, labels, and 2D drafting lines.');
      return;
    }

    if (tool === 'delete') {
      if (project && editorState.selectedIds.length > 0) {
        const idsToRemove = new Set(editorState.selectedIds);
        const selectedWalls = project.elements.filter(el => el.type === 'wall' && editorState.selectedIds.includes(el.id));
        project.elements.forEach(el => {
          if (el.type === 'door' || el.type === 'window' || el.type === 'wall-opening') {
            const isOrphan = selectedWalls.some(wall => isHostedBy(el, wall));
            if (isOrphan) idsToRemove.add(el.id);
          }
        });
        const newElements = project.elements.filter(el => !idsToRemove.has(el.id) || el.locked);
        const nextProject = { ...project, elements: newElements };
        const cleaned = validateOpenings(nextProject.elements);
        nextProject.elements = cleaned;
        setProject(nextProject);
        pushHistory(nextProject);
        onSelectionChange([]);
      }
      return;
    }

    const selectedElements = project?.elements.filter(el => editorState.selectedIds.includes(el.id)) || [];
    const hasOpeningSelected = selectedElements.some(el => ['door', 'window', 'wall-opening'].includes(el.type));
    const hasElevationSelected = selectedElements.some(el => el.type === 'elevation-marker');
    const hasWallSelected = selectedElements.some(el => el.type === 'wall');
    
    if (tool === 'split' && !hasWallSelected) return;
    if (tool === 'rotate' && hasOpeningSelected) return;
    if (tool === 'copy' && hasElevationSelected) return;

    if (tool === 'wall' && editorState.selectedIds.length > 0 && project) {
      const hasGeometry = selectedElements.some(el => ['line', 'rectangle', 'arc', 'circle', 'ellipse'].includes(el.type));
      if (hasGeometry) {
        const newElements = project.elements.map(el => {
          if (editorState.selectedIds.includes(el.id) && ['line', 'rectangle', 'arc', 'circle', 'ellipse'].includes(el.type)) {
            return { 
              ...el, 
              type: 'wall' as const, 
              thickness: editorState.activePreset?.thickness || WALL_THICKNESS_DEFAULT,
              wallSource: el.type,
              isCurved: ['arc', 'circle', 'ellipse'].includes(el.type),
              elevation: 0,
              height: project.settings3D?.wallHeight ?? WALL_HEIGHT_DEFAULT,
              levelId: editorState.activeLevelId 
            };
          }
          return el;
        });
        const nextProject = { ...project, elements: newElements };
        const cleaned = validateOpenings(nextProject.elements);
        nextProject.elements = cleaned;
        setProject(nextProject);
        pushHistory(nextProject);
      }
    }

    setEditorState(s => {
      let nextTool = tool;
      let nextWallMode = s.isWallMode;
      let shouldDeselect = DRAWING_TOOLS.includes(tool);

      if (tool === 'wall') {
         if (s.selectedIds.length === 0) {
             if (preset) {
                 nextWallMode = true; // Picking a preset explicitly enables or keeps wall mode on
             } else {
                 nextWallMode = !s.isWallMode;
             }
             if (nextWallMode) {
                 if (!['line', 'rect', 'arc', 'ellipse', 'circle'].includes(s.activeTool)) {
                     nextTool = 'line';
                 } else {
                     nextTool = s.activeTool;
                 }
             } else {
                 nextTool = s.activeTool;
             }
         } else {
             nextTool = s.activeTool; // Keep current tool if we just converted
         }
      } else if (!['line', 'rect', 'arc', 'circle', 'ellipse'].includes(tool)) {
          // If we clicked something that isn't a shape tool or the wall tool, turn wall mode off.
          // This ensures that 'select', 'door', 'window', etc. deactivate wall mode.
          nextWallMode = false;
      } else {
          // If we clicked a shape tool, keep the current wall mode.
          // (e.g. switching from wall-line to wall-rect keeps isWallMode true)
          // (e.g. switching from select-line to select-rect keeps isWallMode false)
      }

      let nextLastTool = s.lastActiveTool;
      let nextLastIsWallMode = s.lastIsWallMode;
      if (tool !== 'select' && tool !== 'pan') {
          nextLastTool = tool;
          nextLastIsWallMode = nextWallMode;
      }

      if (forceWallMode !== undefined) {
          nextWallMode = forceWallMode;
      }

      return { 
        ...s, 
        activeTool: nextTool, 
        activePreset: preset || s.activePreset,
        isWallMode: nextWallMode,
        selectedIds: shouldDeselect ? [] : s.selectedIds,
        lastActiveTool: nextLastTool,
        lastIsWallMode: nextLastIsWallMode,
        multiPointBuffer: [],
        tempBoundaryIds: []
      };
    });
  }, [editorState.selectedIds, editorState.activeTool, editorState.activePreset, project, onSelectionChange, pushHistory, editorState.activeLevelId, require2DAction]);

  const onUndo = useCallback(() => {
    if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      setProject(JSON.parse(JSON.stringify(prev)));
      setHistoryIndex(historyIndex - 1);
      onSelectionChange([]);
    }
  }, [history, historyIndex, onSelectionChange]);

  const onRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      setProject(JSON.parse(JSON.stringify(next)));
      setHistoryIndex(historyIndex + 1);
      onSelectionChange([]);
    }
  }, [history, historyIndex, onSelectionChange]);

  const onRotate = useCallback(() => {
    handleToolSelect('rotate');
  }, [handleToolSelect]);

  const onMirror = useCallback((axis?: 'horizontal' | 'vertical') => {
    if (editorState.viewMode === '2D' && isElevationDrawingView(editorState.drawingView)) {
      alert('Mirror is available in 2D Plan only. Elevation views keep structure aligned to model levels.');
      return;
    }
    if (!project || editorState.selectedIds.length === 0) return;
    const selectedElements = project.elements.filter(el => editorState.selectedIds.includes(el.id));
    if (selectedElements.some(el => ['door', 'window', 'wall-opening', 'elevation-marker'].includes(el.type))) return;
    
    if (!axis) {
      setShowMirrorOptions(true);
      return;
    }
    setShowMirrorOptions(false);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    project.elements.forEach(el => {
      if (editorState.selectedIds.includes(el.id)) {
        if (el.pos) { minX = Math.min(minX, el.pos.x); maxX = Math.max(maxX, el.pos.x); minY = Math.min(minY, el.pos.y); maxY = Math.max(maxY, el.pos.y); }
        if (el.p1) { minX = Math.min(minX, el.p1.x); minY = Math.min(minY, el.p1.y); maxX = Math.max(maxX, el.p1.x); maxY = Math.max(maxY, el.p1.y); }
        if (el.p2) { minX = Math.min(minX, el.p2.x); minY = Math.min(minY, el.p2.y); maxX = Math.max(maxX, el.p2.x); maxY = Math.max(maxY, el.p2.y); }
        if (el.p3) { minX = Math.min(minX, el.p3.x); minY = Math.min(minY, el.p3.y); maxX = Math.max(maxX, el.p3.x); maxY = Math.max(maxY, el.p3.y); }
        if (el.p4) { minX = Math.min(minX, el.p4.x); minY = Math.min(minY, el.p4.y); maxX = Math.max(maxX, el.p4.x); maxY = Math.max(maxY, el.p4.y); }
        if (el.controlPoint) { minX = Math.min(minX, el.controlPoint.x); minY = Math.min(minY, el.controlPoint.y); maxX = Math.max(maxX, el.controlPoint.x); maxY = Math.max(maxY, el.controlPoint.y); }
        if (el.boundary) el.boundary.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
      }
    });

    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const selectedWalls = project.elements.filter(el => el.type === 'wall' && editorState.selectedIds.includes(el.id));
    const updated = project.elements.map(el => {
      if (el.type === 'elevation-marker') return el;
      const isOpening = ['door', 'window', 'wall-opening'].includes(el.type);
      const hostWall = isOpening ? selectedWalls.find(w => isHostedBy(el, w)) : null;
      if (editorState.selectedIds.includes(el.id) || hostWall) {
        const mirrorPt = (p: Point): Point => {
            if (axis === 'horizontal') return { ...p, x: midX - (p.x - midX) };
            return { ...p, y: midY - (p.y - midY) };
        };

        if (el.pos) {
            let nextRot = el.rotation || 0;
            if (axis === 'horizontal') {
                nextRot = 180 - nextRot;
            } else {
                nextRot = -nextRot;
            }
            return { ...el, pos: mirrorPt(el.pos), rotation: nextRot };
        }
        
        const res = { ...el };
        if (res.p1) res.p1 = mirrorPt(res.p1);
        if (res.p2) res.p2 = mirrorPt(res.p2);
        if (res.p3) res.p3 = mirrorPt(res.p3);
        if (res.p4) res.p4 = mirrorPt(res.p4);
        if (res.controlPoint) res.controlPoint = mirrorPt(res.controlPoint);
        if (res.boundary) res.boundary = res.boundary.map(mirrorPt);
        return res;
      }
      return el;
    });
    const validated = validateOpenings(updated);
    setProject({ ...project, elements: validated });
    pushHistory({ ...project, elements: validated });
  }, [project, editorState.selectedIds, editorState.viewMode, editorState.drawingView, pushHistory, validateOpenings]);

  const fitProjectToView = useCallback((projectToFit: Project | null = project) => {
    if (!projectToFit || projectToFit.elements.length === 0) {
      setEditorState(s => ({ ...s, zoom: 15, offset: { x: window.innerWidth / 2, y: window.innerHeight / 2 } }));
      return;
    }

    // Filter elements to prioritize architectural/user content over elevation markers
    let targets = projectToFit.elements.filter(el => el.type !== 'elevation-marker');
    if (targets.length === 0) targets = projectToFit.elements;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let found = false;

    targets.forEach(el => {
      // Check pos (for furniture, points, some annotations)
      if (el.pos) {
        minX = Math.min(minX, el.pos.x); minY = Math.min(minY, el.pos.y);
        maxX = Math.max(maxX, el.pos.x); maxY = Math.max(maxY, el.pos.y);
        found = true;
      }
      // Check line/wall endpoints
      if (el.p1) {
        minX = Math.min(minX, el.p1.x); minY = Math.min(minY, el.p1.y);
        maxX = Math.max(maxX, el.p1.x); maxY = Math.max(maxY, el.p1.y);
        found = true;
      }
      if (el.p2) {
        minX = Math.min(minX, el.p2.x); minY = Math.min(minY, el.p2.y);
        maxX = Math.max(maxX, el.p2.x); maxY = Math.max(maxY, el.p2.y);
        found = true;
      }
      // Check control points (for arcs)
      if (el.controlPoint) {
        minX = Math.min(minX, el.controlPoint.x); minY = Math.min(minY, el.controlPoint.y);
        maxX = Math.max(maxX, el.controlPoint.x); maxY = Math.max(maxY, el.controlPoint.y);
        found = true;
      }
      // Check boundaries (for floors, rooms, massing)
      if (el.boundary && el.boundary.length > 0) {
        el.boundary.forEach(p => {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });
        found = true;
      }
    });

    if (!found) {
      setEditorState(s => ({ ...s, zoom: 15, offset: { x: window.innerWidth / 2, y: window.innerHeight / 2 } }));
      return;
    }

    const padding = 100;
    const viewWidth = window.innerWidth - padding * 2;
    const viewHeight = window.innerHeight - padding * 2;
    const contentWidth = maxX - minX || 1;
    const contentHeight = maxY - minY || 1;
    
    const zoom = Math.min(viewWidth / contentWidth, viewHeight / contentHeight, 5000);
    setEditorState(s => ({
      ...s,
      zoom,
      offset: {
        x: (window.innerWidth / 2) - ((minX + maxX) / 2) * zoom,
        y: (window.innerHeight / 2) - ((minY + maxY) / 2) * zoom
      }
    }));
  }, [project]);

  const handleSave = useCallback(() => { if (!project) return; localStorage.setItem('archai_current_project', JSON.stringify(project)); setShowSaveFeedback(true); setTimeout(() => setShowSaveFeedback(false), 2000); }, [project]);
  const handleExportProjectJson = useCallback(() => {
    if (!project) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(project, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `${project.name || 'project'}_floorplan.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }, [project]);

  const onFitToView = useCallback(() => fitProjectToView(), [fitProjectToView]);

  const loadImportedProject = useCallback((importedProject: Project) => {
    const nextProject = ensureProjectLayers(importedProject);
    const nextHistoryEntry = JSON.parse(JSON.stringify(nextProject));
    const activeLevelId = nextProject.levels[0]?.id || 'level-1';

    setProject(nextProject);
    setHistory([nextHistoryEntry]);
    setHistoryIndex(0);
    setPlacingImportedElements(null);
    setPlacingImportedLevels(null);
    setPendingDxfImport(null);
    setPendingDxfReview(null);
    setPendingBimReview(null);
    setPendingBimImportReview(null);
    setLayoutWarnings([]);
    viewportFramesRef.current = { '3D': null };
    canvas2DFramesRef.current = {
      plan: null,
      'elevation-n': null,
      'elevation-s': null,
      'elevation-e': null,
      'elevation-w': null,
    };
    setEditorState(s => ({
      ...s,
      activeTool: 'select',
      activePreset: undefined,
      activeLevelId,
      selectedIds: [],
      viewMode: '2D',
      drawingView: 'plan',
      isPanning: false,
      multiPointBuffer: [],
      tempBoundaryIds: [],
      editingBoundaryId: undefined,
      isDraggingSelected: false,
      zoom: nextProject.mode === 'urban' ? 0.5 : 15,
      offset: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      canvasAngle: 0,
    }));
    requestAnimationFrame(() => fitProjectToView(nextProject));
  }, [fitProjectToView]);

  const handleImportProjectJson = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const fallbackName = file.name.replace(/\.json$/i, '') || 'Imported Project';
      const importedProject = normalizeImportedProjectJson(parsed, fallbackName);
      loadImportedProject(importedProject);
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : 'Project JSON import failed.');
    }
  }, [loadImportedProject]);
  const handleBimExportComplete = useCallback((result: BimExportResult) => {
    setProject(result.updatedProject);
  }, []);
  const handleRevitExportJobUpdate = useCallback((job: RevitExportJobResponse) => {
    setProject(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        metadata: {
          ...(prev.metadata || {}),
          revitExport: {
            ...(prev.metadata?.revitExport || {}),
            lastJobId: job.jobId,
            lastStatus: job.status,
            lastProgressMessage: job.progressMessage,
            lastDownloadUrl: job.downloadUrl,
            lastReportUrl: job.reportUrl,
            lastWarnings: job.warnings,
            lastErrors: job.errors || [],
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
  }, []);
  const handleApsRevitImportComplete = useCallback((importedProject: Project, job: any) => {
    const nextProject: Project = {
      ...importedProject,
      metadata: {
        ...(importedProject.metadata || {}),
        apsRevitImport: {
          ...(importedProject.metadata?.apsRevitImport || {}),
          lastJobId: job.jobId,
          lastStatus: job.status,
          manifestUrl: job.manifestUrl,
          projectJsonUrl: job.projectJsonUrl,
          reportUrl: job.reportUrl,
          executionLogUrl: job.executionLogUrl,
          openedAt: new Date().toISOString(),
        },
      },
    };
    loadImportedProject(nextProject);
    setIsApsRevitImportDialogOpen(false);
  }, [loadImportedProject]);
  const handleVectorPdfExport = useCallback(async (options: VectorPdfExportOptions) => {
    if (!require2DAction('vector-pdf-export')) return;
    if (!canvasRef.current) throw new Error('The 2D canvas is not available.');
    await canvasRef.current.exportVectorPdf(options);
  }, [require2DAction]);
  const handleVectorDxfExport = useCallback(async () => {
    if (!require2DAction('vector-dxf-export')) return;
    if (!canvasRef.current) return;
    try {
      await canvasRef.current.exportVectorDxf(project?.name || 'plan');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'DXF export failed.');
    }
  }, [project?.name, require2DAction]);
  const handleSaveCustomBlock = (block: { name: string; width: number; depth: number; height: number; customMeshData?: { vertices: number[]; faces: number[] } }) => {
    if (!project) return;
    const newEl: ArchElement = {
      id: crypto.randomUUID(),
      type: 'furniture',
      subType: block.name,
      label: block.name,
      width: block.width,
      depth: block.depth,
      height: block.height,
      customMeshData: block.customMeshData,
      pos: { x: 0, y: 0 },
      rotation: 0,
      levelId: editorState.activeLevelId
    };
    const nextProject = { ...project, elements: [...project.elements, newEl] };
    setProject(nextProject);
    pushHistory(nextProject);
    alert(`Custom block "${block.name}" created and placed at center of origin.`);
  };
  
  const createBlankProject = () => {
    const defaultLevelId = crypto.randomUUID();
    const proj: Project = {
      name: "New Floorplan",
      mode: 'floorplan',
      levels: [
        { id: defaultLevelId, name: "Level 1", zElevation: 0, height: WALL_HEIGHT_DEFAULT, order: 0 }
      ],
      elements: [
        { id: crypto.randomUUID(), type: 'elevation-marker', direction: 'N', pos: { x: 0, y: -20 }, rotation: 180, levelId: defaultLevelId },
        { id: crypto.randomUUID(), type: 'elevation-marker', direction: 'S', pos: { x: 0, y:  20 }, rotation: 0, levelId: defaultLevelId },
        { id: crypto.randomUUID(), type: 'elevation-marker', direction: 'E', pos: { x:  20, y: 0 }, rotation: -90, levelId: defaultLevelId },
        { id: crypto.randomUUID(), type: 'elevation-marker', direction: 'W', pos: { x: -20, y: 0 }, rotation: 90, levelId: defaultLevelId },
      ],
      viewBox: { width: 100, height: 100 },
      settings3D: { 
          ...DEFAULT_PROJECT_SETTINGS_3D,
          defaultLevelHeight: WALL_HEIGHT_DEFAULT,
          slabThickness: 0.3
      },
    };
    setProject(proj);
    setEditorState(s => ({ ...s, activeLevelId: defaultLevelId }));
    pushHistory(proj);
  };

  const openRenderCanvasFromHome = () => {
    createBlankProject();
    setGenerativeInitialMode('ai-rendering');
    setGenerativeInitialHub('image_studio');
    setGenerativeInitialText4hImageTest(false);
    setIsGenerativeWizardOpen(true);
  };

  const openText4hFromHome = (startWithImageTest: boolean) => {
    createBlankProject();
    setGenerativeInitialMode('chat-v4h');
    setGenerativeInitialText4hImageTest(startWithImageTest);
    setIsGenerativeWizardOpen(true);
  };

  const createBlankUrbanProject = () => {
    const defaultLevelId = crypto.randomUUID();
    const proj: Project = {
      name: "New Masterplan",
      mode: 'urban',
      levels: [
        { id: defaultLevelId, name: "Urban Site", zElevation: 0, height: 100, order: 0 }
      ],
      elements: [],
      viewBox: { width: 2000, height: 2000 },
      urbanSettings: {
        totalSiteArea: 100000,
        targetFAR: 2.5,
        greenSpacePercent: 30
      }
    };
    setProject(proj);
    setEditorState(s => ({ 
      ...s, 
      activeLevelId: defaultLevelId,
      zoom: 0.5, // Zoom out for urban scale
      offset: { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    }));
    pushHistory(proj);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setIsProcessing(true); const reader = new FileReader();
    reader.onload = async () => {
      try { 
          const result = await digitizeFloorplan(reader.result as string); 
          if (result && result.elements) { 
              if (!result.levels || result.levels.length === 0) {
                  const lid = crypto.randomUUID();
                  result.levels = [{ id: lid, name: "Level 1", zElevation: 0, height: WALL_HEIGHT_DEFAULT, order: 0 }];
                  result.elements = result.elements.map(e => ({ ...e, levelId: lid }));
                  setEditorState(s => ({ ...s, activeLevelId: lid }));
              }
              setProject(result); 
              pushHistory(result); 
              setTimeout(onFitToView, 100); 
          } else throw new Error("Invalid format"); 
      }
      catch (err) { alert("Digitization failed."); } finally { setIsProcessing(false); }
    };
    reader.readAsDataURL(file);
  };

  const handleDxfFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!require2DAction('dxf-import')) {
      e.target.value = '';
      return;
    }
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const contents = await file.text();
      const detectedSettings = detectDxfUnitSettings(contents);
      setDxfUnitSettings(detectedSettings);
      setPendingDxfImport({ contents, fileName: file.name });
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : 'DXF import failed.');
    }
  };

  const handleConfirmDxfImport = () => {
    if (!require2DAction('dxf-import')) return;
    if (!pendingDxfImport) return;

    try {
      setIsProcessing(true);
      const result = importDxfToProject(pendingDxfImport.contents, pendingDxfImport.fileName, { unit: dxfUnitSettings.drawingUnit });
      const previewUnitSystem = getDxfPreviewUnitSystem(dxfUnitSettings);
      setEditorState(prev => ({ ...prev, unitSystem: previewUnitSystem }));
      setPendingDxfReview({ fileName: pendingDxfImport.fileName, result, previewUnitSystem });
      setIsGenerativeWizardOpen(true);
      setPendingDxfImport(null);
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : 'DXF import failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRegisterBimAsset = useCallback((asset: {
    name: string;
    width: number;
    depth: number;
    height: number;
    category?: string;
    customMeshData?: { vertices: number[]; faces: number[] };
    bimMetadata: any;
  }) => {
    const baseClassName = BimService.sanitizeImportedClassName(
      asset.bimMetadata?.sourceFileName || asset.bimMetadata?.fileName || asset.name
    );
    const existingClassNames = [
      ...INTERIOR_ELEMENT_PRESETS.map((preset: any) => preset.classname || preset.id || preset.subType),
      ...customRevitPresets.map((preset: any) => preset.classname || preset.id || preset.subType),
    ].filter(Boolean);
    const classname = BimService.makeUniqueClassName(baseClassName, existingClassNames);
    const assetId = `revit_${classname}`;
    const displayName = asset.name || asset.bimMetadata?.displayName || classname;
    const userCategory = asset.category || asset.bimMetadata?.userCategory || 'Custom';
    const fullBimMetadata = BimService.createImportedAssetMetadata({
      fileName: asset.bimMetadata?.sourceFileName || asset.bimMetadata?.fileName || `${displayName}.rfa`,
      fileSize: asset.bimMetadata?.fileSize || 0,
      fileType: asset.bimMetadata?.type || 'RFA',
      displayName,
      classname,
      userCategory,
      width: asset.width,
      depth: asset.depth,
      height: asset.height,
      revitVersion: asset.bimMetadata?.revitVersion,
      rawBmData: asset.bimMetadata?.rawBmData,
      previewUrl: asset.bimMetadata?.previewUrl || asset.bimMetadata?.thumbnail,
      customMeshData: asset.customMeshData,
      description: asset.bimMetadata?.description,
    });
    const persistentBimMetadata = BimService.getPersistentMetadata(fullBimMetadata);
    const mainCategory = getImportedRevitMainCategory(userCategory);
    const newPreset = {
      id: assetId,
      assetId,
      label: displayName,
      width: asset.width,
      depth: asset.depth,
      height: asset.height,
      customMeshData: asset.customMeshData,
      bimMetadata: persistentBimMetadata,
      sourceType: 'revit_import',
      sourceFileType: persistentBimMetadata.sourceFileType,
      sourceFileName: persistentBimMetadata.sourceFileName,
      revitFamilyName: persistentBimMetadata.revitFamilyName,
      revitTypeName: persistentBimMetadata.revitTypeName,
      classname,
      displayName,
      userCategory,
      isImportedAsset: true,
      nativeCatalogAsset: false,
      model3D: persistentBimMetadata.model3D,
      planView2D: persistentBimMetadata.planView2D,
      elevationViews: persistentBimMetadata.elevationViews,
      thumbnail: persistentBimMetadata.thumbnail || persistentBimMetadata.previewUrl,
      dimensions: persistentBimMetadata.dimensions,
      materials: persistentBimMetadata.materials,
      metadata: persistentBimMetadata.metadata,
      importTimestamp: persistentBimMetadata.importTimestamp,
      importVersion: persistentBimMetadata.importVersion,
      category: 'furniture',
      type: 'furniture',
      subType: classname,
      mainCategory,
      subCategory: 'Imported Revit',
      catalogGroup: 'Interior Elements',
      snapMode: 'default',
      iconType: 'revit-import'
    };

    setTimeout(() => {
      setCustomRevitPresets(prev => {
        const updated = [...prev, newPreset];
        try {
          localStorage.setItem('archai_custom_revit_presets', JSON.stringify(updated));
          registerCustomInteriorPresets([newPreset]);
          return updated;
        } catch (err) {
          console.error(err);
          alert('The Revit family was imported for this session, but the browser could not save it permanently because local storage is full.');
          registerCustomInteriorPresets([newPreset]);
          return [...prev, newPreset];
        }
      });
      setPendingBimReview(null);
      setIsGenerativeWizardOpen(false);
    }, 100);
  }, []);

  const handleLoadRvtProjectLayout = useCallback((projectData: {
    fileName: string;
    elements: any[];
    metadata: any;
  }) => {
    setIsProcessing(true);
    try {
      const mappedElements = projectData.elements.map(el => ({
        ...el,
        levelId: editorState.activeLevelId || project?.levels[0]?.id
      }));

      setPlacingImportedElements(mappedElements);
      setPlacingImportedLevels(project?.levels || [{ id: editorState.activeLevelId || 'level1', name: 'Level 1', zElevation: 0, height: 3, order: 0 }]);
      setEditorState(s => ({ ...s, viewMode: '2D', activeTool: 'select', selectedIds: [] }));
    } catch (err) {
      console.error(err);
      alert('Failed to place RVT layout.');
    } finally {
      setIsProcessing(false);
    }
  }, [project, editorState.activeLevelId]);

  // --- MULTI-LEVEL LOGIC ---

  const activeDrawingView = editorState.drawingView || 'plan';
  const activeElevationDirection = editorState.viewMode === '2D' ? getElevationDirection(activeDrawingView) : null;
  const isElevationActive = !!activeElevationDirection;
  const is2DPlanActive = editorState.viewMode === '2D' && activeDrawingView === 'plan';

  const activeProjectElements = useMemo(() => {
    if (!project) return [];
    const firstLevelId = project.levels[0]?.id;
    const isCurrentLevel = (el: ArchElement) => {
      const elLevel = el.levelId || firstLevelId;
      return elLevel === editorState.activeLevelId;
    };

    if (!activeElevationDirection) {
      return project.elements.filter(e => {
        if (e.viewId && e.viewId !== 'plan') return false;
        return isCurrentLevel(e);
      });
    }

    const axisKey = activeElevationDirection === 'N' || activeElevationDirection === 'S' ? 'x' : 'y';
    const depthKey = axisKey === 'x' ? 'y' : 'x';
    const axis = (point?: Point | null) => {
      if (!point) return 0;
      if (activeElevationDirection === 'E') return -point.y;
      return point[axisKey];
    };
    const depth = (point?: Point | null) => point ? point[depthKey] : 0;
    const activeLevel = project.levels.find(level => level.id === editorState.activeLevelId) || project.levels[0];
    const levelZ = activeLevel?.zElevation || 0;
    const settings3D = { ...DEFAULT_PROJECT_SETTINGS_3D, ...(project.settings3D || {}) };
    const liveElements = project.elements.filter(isCurrentLevel);
    const wallElements = liveElements.filter(el => el.type === 'wall' && el.p1 && el.p2);
    const depthValues = wallElements.flatMap(el => [depth(el.p1), depth(el.p2)]);
    const viewFromLowSide = activeElevationDirection === 'N' || activeElevationDirection === 'W';
    const depthTolerance = Math.max(WALL_THICKNESS_DEFAULT, 0.18);
    const axisTolerance = Math.max(WALL_THICKNESS_DEFAULT * 1.25, 0.25);
    const getCloserDepth = (d1: number, d2: number) => viewFromLowSide ? Math.min(d1, d2) : Math.max(d1, d2);
    const isDepthCloser = (candidate: number, target: number) =>
      viewFromLowSide ? candidate < target - depthTolerance : candidate > target + depthTolerance;
    const wallViews = wallElements.map(wall => {
      const a1 = axis(wall.p1);
      const a2 = axis(wall.p2);
      const d1 = depth(wall.p1);
      const d2 = depth(wall.p2);
      const half = Math.max((wall.thickness || WALL_THICKNESS_DEFAULT) / 2, 0.05);
      const axisSpan = Math.abs(a1 - a2);
      const faceOn = axisSpan >= 0.05;
      const minA = faceOn ? Math.min(a1, a2) : a1 - half;
      const maxA = faceOn ? Math.max(a1, a2) : a1 + half;
      return {
        wall,
        faceOn,
        minA,
        maxA,
        centerA: (minA + maxA) / 2,
        depth: faceOn ? (d1 + d2) / 2 : getCloserDepth(d1, d2),
      };
    });
    const faceOnWallViews = wallViews.filter(view => view.faceOn);
    const axisOverlap = (aMin: number, aMax: number, bMin: number, bMax: number) =>
      Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
    const isCoveredByCloserFaceWall = (minA: number, maxA: number, targetDepth: number) => {
      const span = Math.max(maxA - minA, 0.05);
      return faceOnWallViews.some(candidate => {
        if (!isDepthCloser(candidate.depth, targetDepth)) return false;
        const overlap = axisOverlap(minA, maxA, candidate.minA - axisTolerance, candidate.maxA + axisTolerance);
        return overlap >= span * 0.85;
      });
    };
    const visibleWallViews = wallViews.filter(view => !isCoveredByCloserFaceWall(view.minA, view.maxA, view.depth));
    const visibleWallIds = new Set(visibleWallViews.map(view => view.wall.id));
    const visibleFaceOnWallIds = new Set(visibleWallViews.filter(view => view.faceOn).map(view => view.wall.id));
    const wallViewById = new Map(wallViews.map(view => [view.wall.id, view]));
    const isElementVisible = (el: ArchElement) => {
      if (el.type === 'wall') return visibleWallIds.has(el.id);
      if (['door', 'window', 'wall-opening'].includes(el.type)) {
        if (el.hostWallId) return visibleFaceOnWallIds.has(el.hostWallId);
        if (!el.pos) return false;
        return !isCoveredByCloserFaceWall(axis(el.pos) - 0.05, axis(el.pos) + 0.05, depth(el.pos));
      }
      if (el.pos) return !isCoveredByCloserFaceWall(axis(el.pos) - 0.05, axis(el.pos) + 0.05, depth(el.pos));
      if (el.p1 && el.p2) {
        const minA = Math.min(axis(el.p1), axis(el.p2));
        const maxA = Math.max(axis(el.p1), axis(el.p2));
        return !isCoveredByCloserFaceWall(minA, maxA, (depth(el.p1) + depth(el.p2)) / 2);
      }
      return true;
    };
    const structural = liveElements.filter(el => ['wall', 'column', 'door', 'window', 'wall-opening', 'floor', 'ceiling', 'furniture', 'fixture', 'counter'].includes(el.type) && isElementVisible(el));
    const axisValues: number[] = [];
    structural.forEach(el => {
      [el.pos, el.p1, el.p2, el.p3, el.p4, ...(el.boundary || [])].forEach(point => {
        if (point) axisValues.push(axis(point));
      });
    });
    const minAxis = axisValues.length ? Math.min(...axisValues) - 2 : -12;
    const maxAxis = axisValues.length ? Math.max(...axisValues) + 2 : 12;
    const makeRect = (
      source: ArchElement,
      minA: number,
      maxA: number,
      bottomZ: number,
      topZ: number,
      subType: string,
      color: string,
      locked = false,
    ): ArchElement => ({
      ...source,
      type: 'rectangle',
      sourceType: source.type,
      subType,
      p1: { x: minA, y: -topZ },
      p2: { x: maxA, y: -bottomZ },
      pos: undefined,
      boundary: undefined,
      rotation: 0,
      color,
      locked,
      viewId: activeDrawingView,
      levelId: editorState.activeLevelId,
    });

    const getPlanFootprintAxisSpan = (el: ArchElement) => {
      const width = Math.max(el.width || 0.6, 0.05);
      const depthSize = Math.max(el.depth || 0.6, 0.05);
      if (!el.pos) return { minA: -width / 2, maxA: width / 2, centerA: 0 };
      const rotation = (el.rotation || 0) * Math.PI / 180;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const corners = [
        { x: -width / 2, y: -depthSize / 2 },
        { x: width / 2, y: -depthSize / 2 },
        { x: width / 2, y: depthSize / 2 },
        { x: -width / 2, y: depthSize / 2 },
      ].map(corner => ({
        x: el.pos!.x + corner.x * cos - corner.y * sin,
        y: el.pos!.y + corner.x * sin + corner.y * cos,
      }));
      const values = corners.map(axis);
      const minA = Math.min(...values);
      const maxA = Math.max(...values);
      return { minA, maxA, centerA: (minA + maxA) / 2 };
    };

    const projected: ArchElement[] = [];
    const sortedLevels = [...project.levels].sort((a, b) => a.zElevation - b.zElevation);
    const datumItems: Array<{ id: string; level: Level; z: number; label: string; role: 'base' | 'top' }> = [];
    if (sortedLevels.length > 0) {
      const lowest = sortedLevels[0];
      datumItems.push({
        id: `${lowest.id}-base`,
        level: lowest,
        z: lowest.zElevation,
        label: `${lowest.name} Base\n${formatDimension(lowest.zElevation, editorState.unitSystem)}`,
        role: 'base',
      });
      sortedLevels.forEach(level => {
        const topZ = level.zElevation + level.height;
        datumItems.push({
          id: `${level.id}-top`,
          level,
          z: topZ,
          label: `${level.name} Top\n${formatDimension(topZ, editorState.unitSystem)}`,
          role: 'top',
        });
      });
    }

    datumItems.forEach(datum => {
      const isActiveDatum = datum.level.id === editorState.activeLevelId;
      projected.push({
        id: `__elev-datum-${datum.id}`,
        type: 'line',
        subType: 'elevation-datum',
        p1: { x: minAxis, y: -datum.z },
        p2: { x: maxAxis, y: -datum.z },
        label: datum.label,
        color: isActiveDatum ? '#2563eb' : '#64748b',
        locked: true,
        levelId: editorState.activeLevelId,
        viewId: activeDrawingView,
      });
    });

    liveElements.forEach(el => {
      if (el.viewId && el.viewId !== activeDrawingView) return;
      if (el.viewId === activeDrawingView) {
        projected.push(el);
        return;
      }
      if (!isElementVisible(el)) return;

      if (el.type === 'wall' && el.p1 && el.p2) {
        const wallView = wallViewById.get(el.id) as any;
        const minA = wallView?.minA ?? Math.min(axis(el.p1), axis(el.p2));
        const maxA = wallView?.maxA ?? Math.max(axis(el.p1), axis(el.p2));
        const bottomZ = levelZ + (el.elevation || 0);
        const topZ = bottomZ + (el.height || settings3D.wallHeight || activeLevel?.height || WALL_HEIGHT_DEFAULT);
        projected.push(makeRect(el, minA, maxA, bottomZ, topZ, 'elevation-wall', '#334155'));
      } else if (el.type === 'column' && el.pos) {
        const half = Math.max((axisKey === 'x' ? el.width : el.depth) || 0.45, 0.18) / 2;
        const bottomZ = levelZ + (el.elevation || 0);
        const topZ = bottomZ + (el.height || activeLevel?.height || settings3D.wallHeight || WALL_HEIGHT_DEFAULT);
        projected.push(makeRect(el, axis(el.pos) - half, axis(el.pos) + half, bottomZ, topZ, 'elevation-column', '#475569'));
      } else if (['door', 'window', 'wall-opening'].includes(el.type) && el.pos) {
        const center = axis(el.pos);
        const half = Math.max(el.width || (el.type === 'door' ? 0.9 : 1.2), 0.15) / 2;
        const bottomRel = el.type === 'window' ? (el.sillHeight ?? settings3D.windowSillHeight) : (el.elevation || 0);
        const topRel = el.type === 'window'
          ? (el.topHeight ?? settings3D.windowTopHeight)
          : bottomRel + (el.height || (el.type === 'door' ? settings3D.doorHeight : settings3D.wallOpeningHeight));
        projected.push(makeRect(el, center - half, center + half, levelZ + bottomRel, levelZ + topRel, `elevation-${el.type}`, el.type === 'door' ? '#16a34a' : el.type === 'window' ? '#0284c7' : '#d97706'));
      } else if (['furniture', 'fixture', 'counter'].includes(el.type) && el.pos) {
        const span = getPlanFootprintAxisSpan(el);
        const bottomZ = levelZ + (el.elevation || 0);
        const preset = INTERIOR_ELEMENT_PRESETS.find(presetItem => presetItem.id === el.subType);
        const normalized = preset ? normalizeInteriorElement({ ...preset, ...el }) : el;
        const height = Math.max(normalized.height || el.height || (el.type === 'counter' ? 0.9 : 0.75), 0.1);
        const projectedInterior = makeRect(
          el,
          span.minA,
          span.maxA,
          bottomZ,
          bottomZ + height,
          'elevation-interior',
          el.type === 'fixture' ? '#475569' : el.type === 'counter' ? '#334155' : '#64748b',
        );
        projected.push({
          ...projectedInterior,
          label: el.label || preset?.label || el.subType,
          width: Math.max(span.maxA - span.minA, 0.05),
          height,
          depth: el.depth,
        });
      }
    });

    return projected;
  }, [project, editorState.activeLevelId, editorState.unitSystem, activeDrawingView, activeElevationDirection]);

  const mapElevationElementsToProject = useCallback((updatedViewElements: ArchElement[]): ArchElement[] => {
    if (!project || !activeElevationDirection) return project?.elements || [];
    const firstLevelId = project.levels[0]?.id;
    const activeLevel = project.levels.find(level => level.id === editorState.activeLevelId) || project.levels[0];
    const levelZ = activeLevel?.zElevation || 0;
    const axisKey = activeElevationDirection === 'N' || activeElevationDirection === 'S' ? 'x' : 'y';
    const axis = (point?: Point | null) => {
      if (!point) return 0;
      if (activeElevationDirection === 'E') return -point.y;
      return point[axisKey];
    };
    const setAxisCoordinate = (point: Point, value: number): Point => {
      if (axisKey === 'x') return { ...point, x: value };
      return { ...point, y: activeElevationDirection === 'E' ? -value : value };
    };
    const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
    const byId = new Map(updatedViewElements.filter(el => !el.id.startsWith('__elev-')).map(el => [el.id, el]));
    const existingIds = new Set(project.elements.map(el => el.id));
    const levelTopZ = levelZ + (activeLevel?.height || project.settings3D?.defaultLevelHeight || WALL_HEIGHT_DEFAULT);
    const elevationWarnings = new Set<string>();

    const getRect = (el: ArchElement) => {
      const points = [el.p1, el.p2, el.pos].filter(Boolean) as Point[];
      if (points.length === 0) return null;
      const xs = points.map(point => point.x);
      const ys = points.map(point => point.y);
      const width = el.width || Math.max(0.1, Math.max(...xs) - Math.min(...xs));
      const height = el.height || el.depth || Math.max(0.1, Math.max(...ys) - Math.min(...ys));
      if (el.pos && (!el.p1 || !el.p2)) {
        return {
          minA: el.pos.x - width / 2,
          maxA: el.pos.x + width / 2,
          bottomZ: -(el.pos.y + height / 2),
          topZ: -(el.pos.y - height / 2),
          centerA: el.pos.x,
        };
      }
      const minA = Math.min(...xs);
      const maxA = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return { minA, maxA, bottomZ: -maxY, topZ: -minY, centerA: (minA + maxA) / 2 };
    };

    const warnIfCrossesCurrentLevel = (rect: ReturnType<typeof getRect> | null, label?: string) => {
      if (!rect) return;
      if (rect.bottomZ < levelZ - 0.01 || rect.topZ > levelTopZ + 0.01) {
        elevationWarnings.add(`${label || 'Edited element'} crosses the ${activeLevel?.name || 'active level'} vertical range.`);
      }
    };

    const shiftAxis = (point: Point, delta: number): Point => {
      if (axisKey === 'x') return { ...point, x: point.x + delta };
      return { ...point, y: point.y + (activeElevationDirection === 'E' ? -delta : delta) };
    };

    const updateOpening = (source: ArchElement, projected: ArchElement, fallbackType?: ElementType): ArchElement => {
      const rect = getRect(projected);
      if (!rect) return source;
      const openingType = (source.type === 'rectangle' ? fallbackType : source.type) as ElementType;
      const hostWall = project.elements.find(el => el.id === (source.hostWallId || projected.hostWallId));
      const width = Math.max(0.15, rect.maxA - rect.minA || source.width || 1);
      const bottomRel = Math.max(0, rect.bottomZ - levelZ);
      const topRel = Math.max(bottomRel + 0.05, rect.topZ - levelZ);
      let hostT = source.hostT ?? 0.5;
      let pos = source.pos;
      let rotation = source.rotation || 0;

      if (hostWall?.p1 && hostWall.p2) {
        const denom = axis(hostWall.p2) - axis(hostWall.p1);
        if (Math.abs(denom) > 0.001) hostT = clamp01((rect.centerA - axis(hostWall.p1)) / denom);
        pos = {
          x: hostWall.p1.x + (hostWall.p2.x - hostWall.p1.x) * hostT,
          y: hostWall.p1.y + (hostWall.p2.y - hostWall.p1.y) * hostT,
        };
        rotation = Math.atan2(hostWall.p2.y - hostWall.p1.y, hostWall.p2.x - hostWall.p1.x) * 180 / Math.PI;
      } else if (source.pos) {
        const delta = rect.centerA - axis(source.pos);
        pos = shiftAxis(source.pos, delta);
      }

      const next: ArchElement = {
        ...source,
        type: openingType,
        pos,
        rotation,
        width,
        hostWallId: source.hostWallId || projected.hostWallId,
        hostT,
        elevation: bottomRel,
        height: topRel - bottomRel,
        levelId: editorState.activeLevelId,
        viewId: undefined,
        sourceType: undefined,
      };
      if (openingType === 'window') {
        next.sillHeight = bottomRel;
        next.topHeight = topRel;
      }
      return next;
    };

    const updatedExisting = project.elements.flatMap(el => {
      const elLevel = el.levelId || firstLevelId;
      const isCurrentLevel = elLevel === editorState.activeLevelId;
      const projected = byId.get(el.id);

      if (isCurrentLevel && el.viewId === activeDrawingView && !projected) return [];
      if (!isCurrentLevel || !projected) return [el];

      if ((el.type === 'wall' || el.type === 'column') && projected.p1 && projected.p2) {
        const rect = getRect(projected);
        if (!rect) return [el];
        warnIfCrossesCurrentLevel(rect, el.type === 'wall' ? 'Wall' : 'Column');
        const originalCenter = el.pos ? axis(el.pos) : el.p1 && el.p2 ? (axis(el.p1) + axis(el.p2)) / 2 : rect.centerA;
        const delta = rect.centerA - originalCenter;
        const next: ArchElement = {
          ...el,
          elevation: Math.max(0, rect.bottomZ - levelZ),
          height: Math.max(0.05, rect.topZ - rect.bottomZ),
        };
        if (next.pos) next.pos = shiftAxis(next.pos, delta);
        if (next.p1 && next.p2) {
          const originalSpan = Math.abs(axis(next.p2) - axis(next.p1));
          if (originalSpan < 0.05) {
            next.p1 = shiftAxis(next.p1, delta);
            next.p2 = shiftAxis(next.p2, delta);
          } else if (axisKey === 'x') {
            const p1First = next.p1.x <= next.p2.x;
            next.p1 = { ...next.p1, x: p1First ? rect.minA : rect.maxA };
            next.p2 = { ...next.p2, x: p1First ? rect.maxA : rect.minA };
          } else {
            const p1First = axis(next.p1) <= axis(next.p2);
            next.p1 = setAxisCoordinate(next.p1, p1First ? rect.minA : rect.maxA);
            next.p2 = setAxisCoordinate(next.p2, p1First ? rect.maxA : rect.minA);
          }
        }
        return [next];
      }

      if (['door', 'window', 'wall-opening'].includes(el.type)) {
        warnIfCrossesCurrentLevel(getRect(projected), el.type === 'wall-opening' ? 'Wall opening' : el.type[0].toUpperCase() + el.type.slice(1));
        return [updateOpening(el, projected, el.type)];
      }

      if (['furniture', 'fixture', 'counter'].includes(el.type) && projected.p1 && projected.p2) {
        const rect = getRect(projected);
        if (!rect) return [el];
        warnIfCrossesCurrentLevel(rect, el.label || 'Interior element');
        const next: ArchElement = {
          ...el,
          elevation: Math.max(0, rect.bottomZ - levelZ),
          height: Math.max(0.05, rect.topZ - rect.bottomZ),
        };
        if (next.pos) {
          const delta = rect.centerA - axis(next.pos);
          next.pos = shiftAxis(next.pos, delta);
        }
        const span = Math.max(0.05, rect.maxA - rect.minA);
        if (axisKey === 'x') next.width = span;
        else next.depth = span;
        return [next];
      }

      if (el.viewId === activeDrawingView) {
        return [{ ...projected, viewId: activeDrawingView, levelId: editorState.activeLevelId }];
      }

      return [el];
    });

    const additions = updatedViewElements
      .filter(el => !el.id.startsWith('__elev-') && !existingIds.has(el.id) && !el.locked)
      .map(el => {
        const sourceType = el.sourceType === 'revit_import' || el.sourceType === 'aps_revit_import' || el.sourceType === 'bim_export' || el.sourceType === 'bim_import'
          ? undefined
          : (el.sourceType || (el.wallSource as ElementType | undefined));
        if (sourceType && ['door', 'window', 'wall-opening'].includes(sourceType)) {
          warnIfCrossesCurrentLevel(getRect(el), sourceType === 'wall-opening' ? 'Wall opening' : sourceType[0].toUpperCase() + sourceType.slice(1));
          return updateOpening({
            ...el,
            type: sourceType,
            id: el.id,
            levelId: editorState.activeLevelId,
          }, el, sourceType);
        }
        return { ...el, viewId: activeDrawingView, levelId: editorState.activeLevelId };
      });

    if (elevationWarnings.size > 0) {
      setLayoutWarnings(Array.from(elevationWarnings));
    } else if (layoutWarnings.some(warning => warning.includes('crosses the'))) {
      setLayoutWarnings([]);
    }

    return validateOpenings([...updatedExisting, ...additions]);
  }, [project, activeElevationDirection, activeDrawingView, editorState.activeLevelId, validateOpenings, layoutWarnings]);

  const getDxfReviewLevelId = useCallback(() => {
    if (project?.levels.some(level => level.id === editorState.activeLevelId)) return editorState.activeLevelId;
    return project?.levels[0]?.id || editorState.activeLevelId || '0';
  }, [project, editorState.activeLevelId]);

  const handleApplyBimImportFromCopilot = useCallback((convertedPreviewElements: ArchElement[]) => {
    if (!project || !pendingBimImportReview) return;
    if (!require2DAction('bim-import')) return;
    if (!pendingBimImportReview.conversion.canConvert) {
      alert('This IFC session does not contain supported BIM elements that can be converted interactively.');
      return;
    }

    const importedLevels = pendingBimImportReview.conversion.levels.length
      ? pendingBimImportReview.conversion.levels
      : project.levels;
    const importedLayers = pendingBimImportReview.conversion.layers || [];
    const userAuthoredElements = project.elements.filter(el => el.type !== 'elevation-marker');
    const canReplaceDefaultLevel = userAuthoredElements.length === 0
      && project.levels.length <= 1
      && (!project.levels[0] || /^level\s*1$/i.test(project.levels[0].name));
    const existingProjectElements = canReplaceDefaultLevel
      ? project.elements.map(el => el.type === 'elevation-marker' ? { ...el, levelId: importedLevels[0]?.id || el.levelId } : el)
      : project.elements;

    let nextLevels = canReplaceDefaultLevel ? importedLevels.map(level => ({ ...level })) : [...project.levels];
    const levelIdMap = new Map<string, string>();

    if (canReplaceDefaultLevel) {
      importedLevels.forEach(level => levelIdMap.set(level.id, level.id));
    } else {
      importedLevels.forEach(level => {
        const matching = nextLevels.find(existing =>
          existing.name.toLowerCase() === level.name.toLowerCase()
          || Math.abs(existing.zElevation - level.zElevation) < 0.001
        );
        if (matching) {
          levelIdMap.set(level.id, matching.id);
        } else {
          nextLevels.push({ ...level, order: nextLevels.length });
          levelIdMap.set(level.id, level.id);
        }
      });
    }

    nextLevels = nextLevels
      .map((level, index) => ({ ...level, order: index }))
      .sort((a, b) => a.zElevation - b.zElevation || a.order - b.order)
      .map((level, index) => ({ ...level, order: index }));

    const existingIds = new Set(existingProjectElements.map(el => el.id));
    const idMap = new Map<string, string>();
    convertedPreviewElements.forEach(el => {
      idMap.set(el.id, existingIds.has(el.id) ? crypto.randomUUID() : el.id || crypto.randomUUID());
    });

    const importedElements = convertedPreviewElements
      .filter(el => !(el.locked && el.type === 'label' && pendingBimImportReview.conversion.canConvert === false))
      .map(el => ({
        ...el,
        id: idMap.get(el.id) || crypto.randomUUID(),
        levelId: el.levelId ? (levelIdMap.get(el.levelId) || el.levelId) : (nextLevels[0]?.id || editorState.activeLevelId),
        hostWallId: el.hostWallId ? (idMap.get(el.hostWallId) || el.hostWallId) : undefined,
        groupId: el.groupId ? (idMap.get(el.groupId) || el.groupId) : undefined,
        isPlacingDraft: false,
      }));

    const layerMap = new Map<string, any>();
    (project.layers || []).forEach(layer => layerMap.set(layer.name, layer));
    importedLayers.forEach(layer => {
      if (!layerMap.has(layer.name)) layerMap.set(layer.name, layer);
    });

    const settings3D = {
      ...DEFAULT_PROJECT_SETTINGS_3D,
      ...(project.settings3D || {}),
      defaultLevelHeight: importedLevels[0]?.height || project.settings3D?.defaultLevelHeight || DEFAULT_PROJECT_SETTINGS_3D.defaultLevelHeight,
      wallHeight: importedLevels[0]?.height || project.settings3D?.wallHeight || DEFAULT_PROJECT_SETTINGS_3D.wallHeight,
      level1Z: importedLevels[0]?.zElevation ?? project.settings3D?.level1Z ?? DEFAULT_PROJECT_SETTINGS_3D.level1Z,
      level2Z: importedLevels[1]?.zElevation ?? project.settings3D?.level2Z ?? DEFAULT_PROJECT_SETTINGS_3D.level2Z,
    };

    const nextProject: Project = {
      ...project,
      levels: nextLevels,
      layers: Array.from(layerMap.values()),
      elements: validateOpenings([...existingProjectElements, ...importedElements]),
      settings3D,
      mode: 'floorplan',
    };

    setProject(nextProject);
    pushHistory(nextProject);
    setPendingBimImportReview(null);
    setIsGenerativeWizardOpen(false);
    setEditorState(state => ({
      ...state,
      viewMode: '2D',
      drawingView: 'plan',
      activeTool: 'select',
      selectedIds: importedElements.map(el => el.id).slice(0, 1),
      activeLevelId: levelIdMap.get(importedLevels[0]?.id || '') || nextLevels[0]?.id || state.activeLevelId,
    }));
    setTimeout(onFitToView, 50);
  }, [project, pendingBimImportReview, require2DAction, editorState.activeLevelId, validateOpenings, pushHistory, onFitToView]);

  const handleApplyDxfFromCopilot = useCallback(async (scaledElements: ArchElement[], mode: DxfReviewMode) => {
    if (mode === 'bim-interactive') {
      handleApplyBimImportFromCopilot(scaledElements);
      return;
    }
    if (!require2DAction('dxf-import')) return;
    if (!pendingDxfReview) return;
    const levelId = getDxfReviewLevelId();
    const cadElements = scaledElements.map(el => ({ ...el, levelId }));

    let elements: ArchElement[];
    if (mode === 'underlay' || mode === 'ai-gemini') {
      elements = [{
        id: crypto.randomUUID(),
        type: 'cad-underlay',
        label: pendingDxfReview.fileName,
        cadElements,
        levelId,
      }];
    } else if (mode === 'smart-2d') {
      elements = cadElements.map(el => ({ ...el, id: crypto.randomUUID() }));
    } else {
      const rawLines: Array<{ p1: Point; p2: Point; layer: string }> = [];
      const nonLineElements: ArchElement[] = [];
      cadElements.forEach(el => {
        if (el.type === 'line' && el.p1 && el.p2) rawLines.push({ p1: el.p1, p2: el.p2, layer: el.layer || '0' });
        else nonLineElements.push(el);
      });

      const { walls, consumed } = pairLinesToWalls(rawLines);
      const unconsumedLines = rawLines
        .filter((_, index) => !consumed.has(index))
        .map(line => ({ id: crypto.randomUUID(), type: 'line' as const, p1: line.p1, p2: line.p2, layer: line.layer, levelId }));
      elements = [
        ...walls.map(wall => ({ ...wall, id: crypto.randomUUID(), levelId })),
        ...unconsumedLines,
        ...nonLineElements.map(el => ({ ...el, id: crypto.randomUUID(), levelId: el.levelId || levelId })),
      ];
    }

    try {
      setIsProcessing(true);
      if (mode === 'ai-gemini') {
        const underlayId = crypto.randomUUID();
        elements = await convertDxfWithAI(underlayId, levelId, cadElements);
      }
      setPlacingImportedElements(elements);
      setPlacingImportedLevels(project?.levels || [{ id: getDxfReviewLevelId(), name: 'Level 1', zElevation: 0, height: WALL_HEIGHT_DEFAULT, order: 0 }]);
      setPendingDxfReview(null);
      setEditorState(s => ({ ...s, viewMode: '2D', activeTool: 'select', selectedIds: [] }));
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : 'DXF conversion failed.');
    } finally {
      setIsProcessing(false);
    }
  }, [pendingDxfReview, getDxfReviewLevelId, project, require2DAction, handleApplyBimImportFromCopilot]);

  const pendingDxfExternalImport = useMemo(() => pendingDxfReview ? {
    title: 'DXF Import',
    fileName: pendingDxfReview.fileName,
    elements: pendingDxfReview.result.project.elements,
    stats: pendingDxfReview.result.stats,
    unitSystem: pendingDxfReview.previewUnitSystem,
  } : null, [pendingDxfReview]);

  const pendingBimImportExternalImport = useMemo(() => pendingBimImportReview ? {
    title: 'BIM Importer',
    fileName: pendingBimImportReview.fileName,
    elements: pendingBimImportReview.previewElements,
    levels: pendingBimImportReview.previewLevels,
    stats: {
      lines: pendingBimImportReview.conversion.stats.shapes,
      arcs: pendingBimImportReview.conversion.stats.walls,
      circles: pendingBimImportReview.conversion.stats.genericElements,
      layers: pendingBimImportReview.conversion.layers.length,
    },
    isBimImport: true,
    canConvert: pendingBimImportReview.conversion.canConvert,
    logs: pendingBimImportReview.logs,
    bimImportSession: pendingBimImportReview,
  } : null, [pendingBimImportReview]);

  const pendingBimExternalImport = useMemo(() => pendingBimReview ? {
    title: pendingBimReview.name,
    fileName: pendingBimReview.bimMetadata?.fileName || 'BIM Import',
    elements: [
      {
        id: 'preview_bim_el',
        type: 'furniture' as any,
        pos: { x: 0, y: 0 },
        width: pendingBimReview.width,
        depth: pendingBimReview.depth,
        height: pendingBimReview.height,
        subType: pendingBimReview.bimMetadata?.classname || BimService.sanitizeImportedClassName(pendingBimReview.name),
        category: pendingBimReview.bimMetadata?.category || pendingBimReview.category || 'Custom',
        sourceType: 'revit_import',
        isImportedAsset: true,
        nativeCatalogAsset: false,
        planView2D: pendingBimReview.bimMetadata?.planView2D,
        elevationViews: pendingBimReview.bimMetadata?.elevationViews,
        model3D: pendingBimReview.bimMetadata?.model3D,
        classname: pendingBimReview.bimMetadata?.classname,
        customMeshData: pendingBimReview.customMeshData,
        bimMetadata: pendingBimReview.bimMetadata,
        boundary: [
          { x: -pendingBimReview.width / 2, y: -pendingBimReview.depth / 2 },
          { x: pendingBimReview.width / 2, y: -pendingBimReview.depth / 2 },
          { x: pendingBimReview.width / 2, y: pendingBimReview.depth / 2 },
          { x: -pendingBimReview.width / 2, y: pendingBimReview.depth / 2 }
        ]
      }
    ],
    isBimAsset: true,
    bimMetadata: pendingBimReview.bimMetadata
  } : null, [pendingBimReview]);

  const handleElementsChange = useCallback((updatedLevelElements: ArchElement[]) => {
    if (!project) return;
    if (isElevationActive) {
      setProject({ ...project, elements: mapElevationElementsToProject(updatedLevelElements) });
      return;
    }
    const otherElements = project.elements.filter(e => {
        const eLevel = e.levelId || (project.levels[0]?.id);
        return eLevel !== editorState.activeLevelId;
    });
    const validatedCurrent = validateOpenings(updatedLevelElements);
    const finalElements = [...otherElements, ...validatedCurrent];
    setProject({ ...project, elements: finalElements });
  }, [project, editorState.activeLevelId, validateOpenings, isElevationActive, mapElevationElementsToProject]);

  const handleElementsCommit = useCallback((updatedLevelElements: ArchElement[]) => {
    if (!project) return;
    if (isElevationActive) {
      const newProject = { ...project, elements: mapElevationElementsToProject(updatedLevelElements) };
      setProject(newProject);
      pushHistory(newProject);
      return;
    }
    const otherElements = project.elements.filter(e => {
        const eLevel = e.levelId || (project.levels[0]?.id);
        return eLevel !== editorState.activeLevelId;
    });
    const validatedCurrent = validateOpenings(updatedLevelElements);
    const finalElements = [...otherElements, ...validatedCurrent];
    const newProject = { ...project, elements: finalElements };
    setProject(newProject);
    pushHistory(newProject);

    // Removed redundant wizard trigger here as it now opens before drawing
    // Only reset to select if we actually added a new procedural element
    const currentActiveLevelElements = project.elements.filter(e => {
        const eLevel = e.levelId || (project.levels[0]?.id);
        return eLevel === editorState.activeLevelId;
    });
    
    if (updatedLevelElements.length > currentActiveLevelElements.length && (editorState.activeTool === 'procedural-boundary' || editorState.activeTool === 'smart-procedural-boundary')) {
        setEditorState(s => ({ ...s, activeTool: 'select' }));
    }
  }, [project, editorState.activeLevelId, editorState.activeTool, validateOpenings, pushHistory, isElevationActive, mapElevationElementsToProject]);

  // --- UPDATED GENERATIVE APPLY LOGIC FOR MULTI-LEVEL ---
  const handleGenerativeApply = (generatedElements: ArchElement[]) => {
    if (!require2DAction('ai-generation')) return;
    if (!project) return;

    // 1. Identify Unique Levels in generated output
    // The Wizard returns levelIds as strings "0", "1", etc. based on index
    const incomingLevelIndices = new Set(generatedElements.map(e => e.levelId || "0"));
    const sortedIndices = Array.from(incomingLevelIndices).sort();

    let newLevels = [...project.levels];
    const levelIdMap = new Map<string, string>(); // Map "0" -> "real-uuid-1", "1" -> "real-uuid-2"

    // 2. Map or Create Levels
    sortedIndices.forEach(idxStr => {
        const index = parseInt(idxStr, 10);
        // If index 0, map to Active Level ID (usually Ground)
        if (index === 0) {
            levelIdMap.set(idxStr, editorState.activeLevelId);
        } else {
            // Check if level at this index exists in project
            const existingLevel = newLevels.find(l => l.order === index);
            if (existingLevel) {
                levelIdMap.set(idxStr, existingLevel.id);
            } else {
                // Create new level
                const prevLevel = newLevels.find(l => l.order === index - 1) || newLevels[newLevels.length - 1];
                const slab = project.settings3D?.slabThickness || 0.3;
                const elevation = prevLevel ? (prevLevel.zElevation + prevLevel.height + slab) : (index * WALL_HEIGHT_DEFAULT);
                
                const newLevel: Level = {
                    id: crypto.randomUUID(),
                    name: `Level ${index + 1}`,
                    zElevation: elevation,
                    height: project.settings3D?.defaultLevelHeight || WALL_HEIGHT_DEFAULT,
                    order: index
                };
                newLevels.push(newLevel);
                levelIdMap.set(idxStr, newLevel.id);
            }
        }
    });

    // 3. Remap Elements to Real Level IDs
    const mappedElements = generatedElements.map(e => ({
        ...e,
        levelId: levelIdMap.get(e.levelId || "0") || editorState.activeLevelId
    }));

    // 4. Save to placement state
    setPlacingImportedElements(mappedElements);
    setPlacingImportedLevels(newLevels);
    setIsGenerativeWizardOpen(false);
  };

  const handleUrbanApply = (params: UrbanPlanParams) => {
    if (!require2DAction('urban-generation')) return;
    if (!project) return;
    
    // 1. Determine site boundary 
    // We look for any 'landscape' or 'parcel' element, or use a default 400x400m site
    const siteElement = project.elements.find(e => e.type === 'landscape' || e.type === 'parcel');
    const boundary = siteElement?.boundary || [
      { x: -200, y: -200 },
      { x: 200, y: -200 },
      { x: 200, y: 200 },
      { x: -200, y: 200 }
    ];

    const generatedElements = UrbanGeneratorService.generateUrbanLayout(params, boundary, project.elements);
    
    // Filter out previous urban layout elements but keep site elements and zones
    const baseElements = project.elements.filter(el => 
        !['building-mass', 'road', 'landscape', 'water-body', 'urban-block'].includes(el.type) || 
        el.id === siteElement?.id // Keep the site boundary itself
    );

    const newProject: Project = { 
      ...project, 
      elements: [...baseElements, ...generatedElements.filter(e => !baseElements.some(be => be.id === e.id))],
      urbanSettings: {
        ...project.urbanSettings,
        greenSpacePercent: params.greenSpacePercent
      }
    };
    
    setProject(newProject);
    pushHistory(newProject);
    setIsUrbanWizardOpen(false);
    onFitToView();
  };

  const handleSiteImport = (location: SiteLocation, terrain: TerrainSettings) => {
    if (!require2DAction('site-import')) return;
    if (!project) return;
    const nextProject: Project = {
      ...project,
      location,
      terrain
    };
    setProject(nextProject);
    pushHistory(nextProject);
    setIsSiteImportWizardOpen(false);
  };

  const getCurrentBoundary = (): Point[] | undefined => {
    if (!project) return undefined;
    const floor = project.elements.find(e => e.type === 'floor' && e.boundary && e.boundary.length > 2 && (e.levelId === editorState.activeLevelId));
    if (floor) return floor.boundary;
    return undefined;
  };

  const handleElementUpdate = (updatedElement: ArchElement) => { 
      if (!project) return; 
      const elements = project.elements.map(el => el.id === updatedElement.id ? updatedElement : el); 
      const validated = validateOpenings(elements);
      const newProject = { ...project, elements: validated };
      setProject(newProject);
      pushHistory(newProject);
  };
  
  const handleProjectSettings3DCommit = useCallback((settings3D: Project['settings3D']) => {
    if (!project) return;
    const next = { ...project, settings3D: settings3D || undefined };
    setProject(next);
    pushHistory(next);
  }, [project, pushHistory]);

  const handleUpdateLayers = useCallback((layers: any[]) => {
    if (!project) return;
    const next = { ...project, layers };
    setProject(next);
    pushHistory(next);
  }, [project, pushHistory]);

  const getFrameForBounds = useCallback((bounds: ReturnType<typeof getElementsBounds>, canvasAngle = 0): Canvas2DFrame => {
    const viewportWidth = Math.max(window.innerWidth || 1200, 640);
    const viewportHeight = Math.max(window.innerHeight || 800, 420);
    const rightPanelReserve = 360;
    const topReserve = 150;
    const usableWidth = Math.max(360, viewportWidth - rightPanelReserve - 120);
    const usableHeight = Math.max(260, viewportHeight - topReserve - 100);
    const paddedWidth = Math.max(bounds.width || 1, 1);
    const paddedHeight = Math.max(bounds.height || 1, 1);
    const zoom = Math.min(220, Math.max(6, Math.min(usableWidth / paddedWidth, usableHeight / paddedHeight) * 0.82));
    const screenCenter = {
      x: 60 + usableWidth / 2,
      y: topReserve + usableHeight / 2,
    };
    return {
      zoom,
      offset: {
        x: screenCenter.x - bounds.center.x * zoom,
        y: screenCenter.y - bounds.center.y * zoom,
      },
      canvasAngle,
    };
  }, []);

  const getDefaultDrawingFrame = useCallback((viewId: DrawingViewId): Canvas2DFrame => {
    if (!project) return { offset: editorState.offset, zoom: editorState.zoom, canvasAngle: viewId === 'plan' ? editorState.canvasAngle : 0 };
    const firstLevelId = project.levels[0]?.id;
    const activeLevel = project.levels.find(level => level.id === editorState.activeLevelId) || project.levels[0];
    const isCurrentLevel = (el: ArchElement) => (el.levelId || firstLevelId) === editorState.activeLevelId;

    if (viewId === 'plan') {
      const planElements = project.elements.filter(el => isCurrentLevel(el) && (!el.viewId || el.viewId === 'plan') && el.type !== 'elevation-marker');
      return getFrameForBounds(getElementsBounds(planElements.length ? planElements : project.elements.filter(isCurrentLevel)), editorState.canvasAngle || 0);
    }

    const direction = getElevationDirection(viewId);
    if (!direction) return { offset: editorState.offset, zoom: editorState.zoom, canvasAngle: 0 };
    const axisKey = direction === 'N' || direction === 'S' ? 'x' : 'y';
    const axis = (point?: Point | null) => {
      if (!point) return 0;
      if (direction === 'E') return -point.y;
      return point[axisKey];
    };
    const liveElements = project.elements.filter(isCurrentLevel);
    const points: Point[] = [];
    const pushElevationPoint = (a: number, z: number) => points.push({ x: a, y: -z });
    const levelBase = activeLevel?.zElevation || 0;
    const levelTop = levelBase + (activeLevel?.height || project.settings3D?.defaultLevelHeight || WALL_HEIGHT_DEFAULT);

    liveElements.forEach(el => {
      const bottomZ = levelBase + (el.elevation || 0);
      const topZ = bottomZ + (el.height || (el.type === 'wall' ? (project.settings3D?.wallHeight || activeLevel?.height || WALL_HEIGHT_DEFAULT) : 0.9));
      [el.pos, el.p1, el.p2, el.p3, el.p4, ...(el.boundary || [])].forEach(point => {
        if (!point) return;
        pushElevationPoint(axis(point), bottomZ);
        pushElevationPoint(axis(point), Math.max(topZ, levelTop));
      });
    });

    const axisValues = points.map(point => point.x);
    const minAxis = axisValues.length ? Math.min(...axisValues) - 2 : -12;
    const maxAxis = axisValues.length ? Math.max(...axisValues) + 2 : 12;
    project.levels.forEach(level => {
      pushElevationPoint(minAxis, level.zElevation);
      pushElevationPoint(maxAxis, level.zElevation + level.height);
    });
    return getFrameForBounds(getElementsBounds(points.map((point, index) => ({ id: `frame-${index}`, type: 'line', p1: point, p2: point } as ArchElement))), 0);
  }, [editorState.activeLevelId, editorState.canvasAngle, editorState.offset, editorState.zoom, getFrameForBounds, project]);

  const handleTransform = useCallback((offset: Point, zoom: number) => {
    setEditorState(s => {
      if (s.viewMode === '2D') {
        const viewId = s.drawingView || 'plan';
        canvas2DFramesRef.current[viewId] = { offset, zoom, canvasAngle: viewId === 'plan' ? (s.canvasAngle || 0) : 0 };
      }
      return { ...s, offset, zoom };
    });
  }, []);

  const switchDrawingView = useCallback((viewId: DrawingViewId) => {
    setEditorState(s => {
      const currentView = s.drawingView || 'plan';
      canvas2DFramesRef.current[currentView] = {
        offset: s.offset,
        zoom: s.zoom,
        canvasAngle: currentView === 'plan' ? (s.canvasAngle || 0) : 0,
      };
      const frame = canvas2DFramesRef.current[viewId] || getDefaultDrawingFrame(viewId);
      return {
        ...s,
        viewMode: '2D',
        drawingView: viewId,
        offset: frame.offset,
        zoom: frame.zoom,
        canvasAngle: viewId === 'plan' ? (frame.canvasAngle || 0) : 0,
        selectedIds: [],
        activeTool: 'select',
        isWallMode: false,
        multiPointBuffer: [],
        tempBoundaryIds: [],
      };
    });
  }, [getDefaultDrawingFrame]);

  const switchViewMode = useCallback((mode: '2D' | '3D') => {
    setEditorState(s => {
      if (s.viewMode === mode) return s;
      if (s.viewMode === '2D') {
        const currentView = s.drawingView || 'plan';
        canvas2DFramesRef.current[currentView] = {
          offset: s.offset,
          zoom: s.zoom,
          canvasAngle: currentView === 'plan' ? (s.canvasAngle || 0) : 0,
        };
      }
      if (mode === '2D') {
        const frame = canvas2DFramesRef.current.plan || getDefaultDrawingFrame('plan');
        return { ...s, viewMode: '2D', drawingView: 'plan', offset: frame.offset, zoom: frame.zoom, canvasAngle: frame.canvasAngle || 0, selectedIds: [] };
      }
      return { ...s, viewMode: mode, selectedIds: [] };
    });
  }, [getDefaultDrawingFrame]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent shortcuts when user is typing in an input field or textarea (such as AI Gen Design Copilot)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable) {
        return;
      }

      if (e.key === 'F7') { e.preventDefault(); setEditorState(s => ({ ...s, isGridVisible: !s.isGridVisible })); }
      if (e.key === 'F8') { e.preventDefault(); setEditorState(s => ({ ...s, isOrthoEnabled: !s.isOrthoEnabled })); }
      if (e.key === 'F9') { e.preventDefault(); if(editorState.isGridVisible) setEditorState(s => ({ ...s, isSnapEnabled: !s.isSnapEnabled })); }
      
      if (editorState.activeTool === 'walk' && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() !== 'escape') {
        return; // Prevent WASD and other drawing shortcuts from triggering while walking
      }

      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        cmdBuffer.current += e.key; const upperBuf = cmdBuffer.current.toUpperCase();
        if (upperBuf.endsWith("DIM")) { handleToolSelect('dimension'); cmdBuffer.current = ""; }
        if (upperBuf.endsWith("REC")) { handleToolSelect('rect'); cmdBuffer.current = ""; }
        if (upperBuf.endsWith("GR")) { handleToolSelect('gridline'); cmdBuffer.current = ""; }
        if (upperBuf.endsWith("CO")) { handleToolSelect('copy'); cmdBuffer.current = ""; }
        if (upperBuf.endsWith("RO")) { handleToolSelect('rotate'); cmdBuffer.current = ""; }
        if (upperBuf.endsWith("MIH")) { onMirror('horizontal'); cmdBuffer.current = ""; }
        else if (upperBuf.endsWith("MIV")) { onMirror('vertical'); cmdBuffer.current = ""; }
        else if (upperBuf.endsWith("MI")) { onMirror(); cmdBuffer.current = ""; }
        if (upperBuf.endsWith("ZE")) { onFitToView(); cmdBuffer.current = ""; }
        if (cmdTimeout.current) window.clearTimeout(cmdTimeout.current);
        cmdTimeout.current = window.setTimeout(() => { cmdBuffer.current = ""; }, 1000);
      }
      if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.shiftKey) { if (editorState.activeTool !== 'pan') { toolBeforeSpace.current = editorState.activeTool; setEditorState(s => ({ ...s, activeTool: 'pan' })); } return; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'g': handleToolSelect('gridline'); break;
          case 'l': handleToolSelect('line'); break;
          case 'w': handleToolSelect('wall'); break;
          case 'd': handleToolSelect('door'); break;
          case 'c': handleToolSelect('column'); break;
          case 's': handleToolSelect('stair'); break;
          case 'x': handleToolSelect('split'); break;
          case 'a': handleToolSelect('arc'); break;
          case 'e': handleToolSelect('ellipse'); break;
          case 'f': onFitToView(); break;
          case 't': handleToolSelect('room'); break; 
          case 'v': handleToolSelect('select'); break;
          case 'h': handleToolSelect('pan'); break;
          case 'm': if(editorState.selectedIds.length > 0) handleToolSelect('move'); break;
          case 'r': handleToolSelect('rotate'); break;
          case 'enter': if (editorState.lastActiveTool) handleToolSelect(editorState.lastActiveTool, undefined, editorState.lastIsWallMode); break;
          case 'escape': onSelectionChange([]); handleToolSelect('select'); break;
          case 'delete': case 'backspace': handleToolSelect('delete'); break;
        }
      }
      if (e.shiftKey && e.key.toLowerCase() === 'f') handleToolSelect(((INTERIOR_ELEMENT_PRESETS[0] as any).type || 'furniture') as EditorTool, INTERIOR_ELEMENT_PRESETS[0]);
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'g': 
            e.preventDefault();
            if (e.shiftKey) onUngroup();
            else onGroup();
            break;
          case 's': e.preventDefault(); handleSave(); break;
          case 'z': e.preventDefault(); onUndo(); break;
          case 'y': e.preventDefault(); onRedo(); break;
          case 'c': e.preventDefault(); handleToolSelect('copy'); break;
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => { 
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable) {
        return;
      }
      if (e.key === ' ' && toolBeforeSpace.current) { setEditorState(s => ({ ...s, activeTool: toolBeforeSpace.current! })); toolBeforeSpace.current = null; } 
    };
    window.addEventListener('keydown', handleKeyDown); window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, [onUndo, onRedo, handleSave, onFitToView, project, editorState, onSelectionChange, handleToolSelect]);

  useEffect(() => {
    const performConversion2D = (targetId: string) => {
      if (!project) return;
      const underlay = project.elements.find(el => el.id === targetId);
      if (!underlay || underlay.type !== 'cad-underlay' || !underlay.cadElements) return;

      // Keep the underlay but mark it as converted to 2D
      const updatedElements = project.elements.map(el => {
        if (el.id === targetId) {
          return {
            ...el,
            converted2d: true
          };
        }
        return el;
      });

      // Convert 100% of elements as-is (lines remain lines, circles remain circles, etc.) and tag them with parentUnderlayId
      const convertedElements = underlay.cadElements.map(el => ({
        ...el,
        id: crypto.randomUUID(),
        parentUnderlayId: targetId,
        levelId: el.levelId || underlay.levelId
      }));

      const newElements = [...updatedElements, ...convertedElements];
      const updatedProject = {
        ...project,
        elements: newElements
      };

      setProject(updatedProject);
      pushHistory(updatedProject);
      
      setEditorState(s => ({
        ...s,
        selectedIds: convertedElements.map(el => el.id)
      }));
    };

    const runDeterministic3DConvert = (targetId: string) => {
      if (!project) return;
      const underlay = project.elements.find(el => el.id === targetId);
      if (!underlay || underlay.type !== 'cad-underlay') return;

      // Retrieve active elements on canvas that belong to this underlay
      const canvasCadElements = project.elements.filter(el => el.parentUnderlayId === targetId);

      // Remaining elements in project, removing both the underlay and its associated raw elements
      const remainingElements = project.elements.filter(el => el.id !== targetId && el.parentUnderlayId !== targetId);

      const rawLines: any[] = [];
      const nonLineElements: ArchElement[] = [];

      canvasCadElements.forEach(el => {
        if (el.type === 'line' && el.p1 && el.p2) {
          rawLines.push({ p1: el.p1, p2: el.p2, layer: el.layer });
        } else {
          nonLineElements.push(el);
        }
      });

      const { walls, consumed } = pairLinesToWalls(rawLines);

      const unconsumedLines: ArchElement[] = [];
      rawLines.forEach((line, index) => {
        if (!consumed.has(index)) {
          unconsumedLines.push({
            id: crypto.randomUUID(),
            type: 'line',
            p1: line.p1,
            p2: line.p2,
            layer: line.layer,
            levelId: underlay.levelId,
            parentUnderlayId: targetId
          });
        }
      });

      const convertedWalls = walls.map(w => ({
        ...w,
        levelId: underlay.levelId
      }));

      const convertedOthers = nonLineElements.map(el => ({
        ...el,
        levelId: el.levelId || underlay.levelId
      }));

      const convertedElements = [...convertedWalls, ...unconsumedLines, ...convertedOthers];
      const newElements = [...remainingElements, ...convertedElements];
      const updatedProject = {
        ...project,
        elements: newElements
      };

      setProject(updatedProject);
      pushHistory(updatedProject);
      
      setEditorState(s => ({
        ...s,
        selectedIds: convertedElements.map(el => el.id),
        viewMode: '3D'
      }));
    };

    const runAI3DConvert = async (targetId: string) => {
      if (!project) return;
      const underlay = project.elements.find(el => el.id === targetId);
      if (!underlay || underlay.type !== 'cad-underlay') return;

      // Retrieve active elements on canvas that belong to this underlay
      const canvasCadElements = project.elements.filter(el => el.parentUnderlayId === targetId);

      // Remaining elements in project, removing both the underlay and its associated raw elements
      const remainingElements = project.elements.filter(el => el.id !== targetId && el.parentUnderlayId !== targetId);

      try {
        setIsProcessing(true);
        // Pass the underlay, levelId, and current canvasCadElements so AI operates on EXACTLY what the user left!
        const convertedElements = await convertDxfWithAI(underlay.id, underlay.levelId || '0', canvasCadElements);

        const newElements = [...remainingElements, ...convertedElements];
        const updatedProject = {
          ...project,
          elements: newElements
        };

        setProject(updatedProject);
        pushHistory(updatedProject);
        
        setEditorState(s => ({
          ...s,
          selectedIds: convertedElements.map(el => el.id),
          viewMode: '3D'
        }));
      } catch (err) {
        console.error("AI 3D convert failed:", err);
      } finally {
        setIsProcessing(false);
      }
    };

    const handleSmartConvert = (e: Event) => {
      const customEvent = e as CustomEvent<{ id: string; mode: '2d' | '3d-script' | '3d-ai' }>;
      const targetId = customEvent.detail?.id;
      const mode = customEvent.detail?.mode || '2d';
      if (!targetId || !project) return;
      if (!require2DAction(mode === '3d-ai' ? 'ai-generation' : 'dxf-import')) return;

      if (mode === '2d') {
        performConversion2D(targetId);
      } else if (mode === '3d-script') {
        runDeterministic3DConvert(targetId);
      } else if (mode === '3d-ai') {
        runAI3DConvert(targetId);
      }
    };

    window.addEventListener('smart-convert-cad', handleSmartConvert);
    return () => {
      window.removeEventListener('smart-convert-cad', handleSmartConvert);
    };
  }, [project, pushHistory, require2DAction]);

  const handleConfirmConvert3d = async (confirmed: boolean) => {
    // Legacy modal handler, we can leave empty or keep it as-is
    setPendingConvert3dId(null);
  };

  const handleRegenerateProcedural = useCallback((
    hostId: string, 
    boundaryPoints: Point[], 
    config?: ProceduralConfig | any
  ) => {
    if (!require2DAction('procedural-regenerate')) return;
    if (!project) return;
    const host = project.elements.find(e => e.id === hostId);
    if (!host) return;

    // Map high-level config to internal parameters
    const pId = host.proceduralId || hostId;
    
    const finalProgramId = config?.programId 
        || (config?.typology ? (PROCEDURAL_TYPOLOGIES.find((t: any) => t.id === config.typology)?.programId) : null)
        || host.proceduralProgramId 
        || 'residential-house';

    const finalStyle = config?.style || host.proceduralTypology || 'Standard';
    const finalGeometry = config?.geometry || host.proceduralGeometry || 'Rectilinear';
    
    // Merge requirements and globals into a single flat object for the engine
    let finalReqs = { ...(host.proceduralRequirements || {}) };
    if (config) {
        if (config.subtype) {
            finalReqs.subtype = config.subtype;
        }
        if (config.requirements) {
            finalReqs = { ...finalReqs, ...config.requirements };
        }
        if (config.globals) {
            finalReqs = { ...finalReqs, ...config.globals };
        }
        // If config is flat (legacy/simplified)
        if (!config.requirements && !config.globals) {
            finalReqs = { ...finalReqs, ...config };
            // Remove meta fields that shouldn't go to requirements
            delete (finalReqs as any).programId;
            delete (finalReqs as any).style;
            delete (finalReqs as any).geometry;
        }
    }

    const isSmart = !!(host.isSmartProceduralHost || config?.isSmartProcedural);
    const engineToUse = isSmart ? SmartProceduralLayoutEngine : ProceduralLayoutEngine;

    const { elements: newElems, warnings } = engineToUse.generateLayout(
        boundaryPoints || host.proceduralBoundaryPoints || [], 
        finalProgramId, 
        {
            seed: Math.random(),
            typology: finalStyle as LayoutTypology,
            geometry: finalGeometry as LayoutGeometry,
            unitSystem: editorState.unitSystem,
            requirements: finalReqs
        }
    );

    setLayoutWarnings(warnings || []);
    
    const elementsToKeep = project.elements.filter(el => el.proceduralId !== pId && el.id !== hostId);
    
    const updatedHost: ArchElement = {
        ...host,
        proceduralProgramId: finalProgramId,
        proceduralTypology: finalStyle,
        proceduralGeometry: finalGeometry,
        proceduralRequirements: finalReqs,
        proceduralBoundaryPoints: boundaryPoints || host.proceduralBoundaryPoints,
        isProceduralHost: true,
        isSmartProceduralHost: isSmart ? true : undefined,
        proceduralId: pId
    };

    const elementsToAdd = newElems.map(el => ({ 
      ...el, 
      proceduralId: pId, 
      levelId: host.levelId || editorState.activeLevelId
    }));

    const finalProject = { ...project, elements: [...elementsToKeep, updatedHost, ...elementsToAdd] };
    const validated = validateOpenings(finalProject.elements);
    setProject({ ...finalProject, elements: validated });
    pushHistory({ ...finalProject, elements: validated });
  }, [project, editorState.unitSystem, editorState.activeLevelId, pushHistory, require2DAction]);

  const handleFurnishFloor = useCallback((floorId: string) => {
    if (!require2DAction('furnish-floor')) return;
    if (!project) return;
    const floor = project.elements.find(e => e.id === floorId);
    if (!floor) return;

    const pId = floor.proceduralId || floorId;

    // Filter out existing furniture/fixtures/counters belonging to this procedural floorplan
    const elementsToKeep = project.elements.filter(
      el => !(el.proceduralId === pId && (el.type === 'furniture' || el.type === 'fixture' || el.type === 'counter'))
    );

    // Call the engine
    const isSmart = !!floor.isSmartProceduralHost;
    const newFurniture = (isSmart 
      ? SmartProceduralFurnishEngine.furnishFloor(floor, project.elements)
      : ProceduralFurnishEngine.furnishFloor(floor, project.elements)
    ).map(normalizeInteriorElement);

    // Combine
    const finalElements = [...elementsToKeep, ...newFurniture];
    const validated = validateOpenings(finalElements);
    const newProject = { ...project, elements: validated };
    setProject(newProject);
    pushHistory(newProject);
  }, [project, pushHistory, validateOpenings, require2DAction]);

  const handleMapUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (!project) return;
      const next: Project = {
        ...project,
        siteMap: {
          url: reader.result as string,
          opacity: 0.5,
          scale: 1.0,
          offset: { x: 0, y: 0 },
          rotation: 0,
          isVisible: true
        }
      };
      setProject(next);
      pushHistory(next);
      setEditorState(s => ({ ...s, isSiteMapVisible: true }));
    };
    reader.readAsDataURL(file);
  };

  const handleUpdateSiteMap = (siteMap: Project['siteMap']) => {
    if (!project) return;
    const next = { ...project, siteMap };
    setProject(next);
    pushHistory(next);
  };

  const dxfImportUnitsDialog = pendingDxfImport ? (
    <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-sm z-[500] flex items-center justify-center p-6">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div>
            <h2 className="text-lg font-bold text-slate-900">DXF Import Units</h2>
            <p className="text-xs text-slate-500 mt-1">Source: {pendingDxfImport.fileName}</p>
          </div>
          <button onClick={() => setPendingDxfImport(null)} className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-white transition-colors" title="Cancel DXF import">
            <ChevronLeft size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-bold">Note:</span> Select units consistent with the source drawing. AutoCAD metadata is shown below, but geometry is scaled using Drawing Coordinate Units.
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Drawing Coordinate Units - Used For Scale</span>
              <select
                value={dxfUnitSettings.drawingUnit}
                onChange={event => setDxfUnitSettings(settings => ({ ...settings, drawingUnit: event.target.value as Exclude<DxfImportUnit, 'auto'> }))}
                className="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-amber-300"
              >
                {DXF_IMPORT_UNIT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <p className="text-xs text-slate-500">For your 300m / 984.252ft test line, keep this set to Meters.</p>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Length - Type</span>
              <select
                value={dxfUnitSettings.lengthType}
                onChange={event => {
                  const lengthType = event.target.value as DxfLengthType;
                  setDxfUnitSettings(settings => ({ ...settings, lengthType, lengthPrecision: DXF_LENGTH_PRECISION_OPTIONS[lengthType][0] }));
                }}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
              >
                {DXF_LENGTH_TYPES.map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Length - Precision</span>
              <select
                value={dxfUnitSettings.lengthPrecision}
                onChange={event => setDxfUnitSettings(settings => ({ ...settings, lengthPrecision: event.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
              >
                {DXF_LENGTH_PRECISION_OPTIONS[dxfUnitSettings.lengthType].map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>

            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Insertion Scale Units - AutoCAD Metadata</span>
              <select
                value={dxfUnitSettings.insertionUnit}
                onChange={event => setDxfUnitSettings(settings => ({ ...settings, insertionUnit: event.target.value as Exclude<DxfImportUnit, 'auto'> }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
              >
                {DXF_IMPORT_UNIT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Lighting</span>
              <select
                value={dxfUnitSettings.lighting}
                onChange={event => setDxfUnitSettings(settings => ({ ...settings, lighting: event.target.value as DxfLightingUnit }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
              >
                {DXF_LIGHTING_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Angle - Type</span>
              <select
                value={dxfUnitSettings.angleType}
                onChange={event => {
                  const angleType = event.target.value as DxfAngleType;
                  setDxfUnitSettings(settings => ({ ...settings, angleType, anglePrecision: DXF_ANGLE_PRECISION_OPTIONS[angleType][0] }));
                }}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
              >
                {DXF_ANGLE_TYPES.map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>

            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Angle - Precision</span>
              <select
                value={dxfUnitSettings.anglePrecision}
                onChange={event => setDxfUnitSettings(settings => ({ ...settings, anglePrecision: event.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
              >
                {DXF_ANGLE_PRECISION_OPTIONS[dxfUnitSettings.angleType].map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 bg-slate-50">
          <button onClick={() => setPendingDxfImport(null)} className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-100">
            Cancel
          </button>
          <button onClick={handleConfirmDxfImport} className="px-5 py-2 rounded-lg bg-amber-500 text-sm font-bold text-slate-950 hover:bg-amber-400 shadow-sm">
            Import DXF
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (!project && !isProcessing) {
    return (
      <div className="app-home min-h-screen flex items-center justify-center p-6">
        <div className="app-home-card max-w-sm w-full bg-white rounded-3xl overflow-hidden p-7 flex flex-col items-center text-center space-y-5">
          <div className="w-14 h-14 bg-blue-100 rounded-full flex items-center justify-center"><Upload className="w-7 h-7 text-blue-600" /></div>
          <div className="space-y-1"><h1 className="text-xl font-bold text-slate-900 tracking-tight">ArchAI Digitizer</h1><p className="text-xs text-slate-500">Transform sketches into professional CAD data.</p></div>
          <div className="w-full space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <button onClick={createBlankProject} className="w-full py-3 bg-slate-900 text-white rounded-2xl font-semibold hover:bg-slate-800 transition-all flex flex-col items-center justify-center gap-1.5">
                <Plus className="w-4 h-4" />
                <span className="text-xs">Drawing Canvas</span>
              </button>
              <button onClick={openRenderCanvasFromHome} className="w-full py-3 bg-blue-600 text-white rounded-2xl font-semibold hover:bg-blue-700 transition-all flex flex-col items-center justify-center gap-1.5">
                <Sparkles className="w-4 h-4" />
                <span className="text-xs">Render Canvas</span>
              </button>
              <button onClick={() => openText4hFromHome(false)} className="w-full py-3 bg-white text-slate-900 border border-blue-200 rounded-2xl font-semibold hover:bg-blue-50 hover:border-blue-300 transition-all flex flex-col items-center justify-center gap-1.5">
                <Wand2 className="w-4 h-4 text-blue-600" />
                <span className="text-xs">AutoPlan</span>
              </button>
              <button onClick={() => openText4hFromHome(true)} className="w-full py-3 bg-blue-50 text-blue-700 border border-blue-200 rounded-2xl font-semibold hover:bg-blue-100 hover:border-blue-300 transition-all flex flex-col items-center justify-center gap-1.5">
                <ScanLine className="w-4 h-4" />
                <span className="text-xs">AutoScan</span>
              </button>
            </div>
          </div>
        </div>
        {dxfImportUnitsDialog}
      </div>
    );
  }

  if (isProcessing) return <div className="app-home min-h-screen flex items-center justify-center text-slate-900"><Loader2 className="w-10 h-10 animate-spin mr-3 text-blue-600" /> Analyzing Floorplan...</div>;

  const currentLevel = project?.levels.find(l => l.id === editorState.activeLevelId);

  const selectedElementsUI = project?.elements.filter(el => editorState.selectedIds.includes(el.id)) || [];
  const topLevelItems = selectedElementsUI.filter(el => 
    !el.groupId || !editorState.selectedIds.includes(el.groupId)
  );
  const isSingleGroupSelected = topLevelItems.length === 1 && (
    topLevelItems[0].type === 'group' || 
    selectedElementsUI.some(el => el.groupId === topLevelItems[0].id)
  );

  const hasOpeningSelected = selectedElementsUI.some(el => ['door', 'window', 'wall-opening'].includes(el.type));
  const hasElevationSelected = selectedElementsUI.some(el => el.type === 'elevation-marker');
  const hasWallSelected = selectedElementsUI.some(el => el.type === 'wall');
  const buildVersion = (import.meta as any).env?.VITE_BUILD_TIMESTAMP || 'Development build';

  return (
    <div className="apple-app-shell relative w-screen h-screen overflow-hidden bg-slate-50 flex flex-col">
      <div className="fixed top-0 left-0 right-0 h-14 bg-white/95 backdrop-blur-md border-b border-slate-200/80 flex items-center justify-between px-6 z-[200] shadow-sm">
        {/* Left: Back Button & Project Title */}
        <div className="flex items-center gap-3">
          <button 
            onClick={navigateBackOneStep}
            className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
            title={hasOpenNavigationLayer ? 'Back one step' : 'Back to Home'}
          >
            <ChevronLeft size={20} />
          </button>
          <div className="h-4 w-px bg-slate-200" />
          <h1 className="font-semibold text-sm text-slate-800 tracking-tight">{project?.name || 'Untitled Plan'}</h1>
        </div>

        {/* Right: Hidden Inputs & Minimalist Apple Hamburger Menu */}
        <div className="flex items-center gap-2">
          <input
            ref={dxfFileInputRef}
            type="file"
            className="hidden"
            accept=".dxf,application/dxf,text/plain"
            onChange={handleDxfFileUpload}
          />
          <input
            ref={projectJsonFileInputRef}
            type="file"
            className="hidden"
            accept=".json,application/json,text/json"
            onChange={handleImportProjectJson}
          />

          {isFirebaseConfigured && currentUser && (
            <button
              onClick={() => { setTokenShortfall(null); setIsTokensPanelOpen(true); }}
              className="px-2.5 py-1.5 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100/80 transition-all flex items-center gap-1.5 cursor-pointer"
              title="Tokens — click to see costs and top up"
            >
              <Coins size={15} className="text-slate-500" />
              <span className="text-xs font-bold tabular-nums">
                {accountBalance.status === 'ok' ? accountBalance.tokenBalance.toLocaleString() : '—'}
              </span>
            </button>
          )}

          {isFirebaseConfigured && (
            currentUser ? (
              // This used to sign out on a single click of the avatar, with no confirmation
              // and no other way to reach account settings — one misclick dropped whatever
              // was unsaved. It now opens a menu instead.
              <div className="relative" ref={accountMenuRef}>
                <button
                  onClick={() => setIsAccountMenuOpen(open => !open)}
                  className="p-2 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100/80 transition-all flex items-center justify-center cursor-pointer"
                  aria-haspopup="menu"
                  aria-expanded={isAccountMenuOpen}
                  title={`Signed in as ${currentUser.email || currentUser.displayName || 'user'}`}
                >
                  <UserCircle size={20} />
                </button>

                {isAccountMenuOpen && (
                  <div
                    className="absolute right-0 top-full mt-2 w-56 rounded-2xl border border-slate-200/80 bg-white/95 backdrop-blur-xl p-1.5 shadow-2xl shadow-slate-900/12 z-[250] animate-in fade-in zoom-in-95 duration-100 select-none"
                    role="menu"
                  >
                    <div className="px-3 py-2 border-b border-slate-100 mb-1.5">
                      <p className="text-xs font-bold text-slate-900 truncate">{currentUser.displayName || 'Signed in'}</p>
                      <p className="text-[10px] font-medium text-slate-400 truncate">{currentUser.email}</p>
                    </div>
                    <button
                      onClick={() => { setIsAccountMenuOpen(false); setIsProjectsPanelOpen(true); }}
                      className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer"
                      role="menuitem"
                    >
                      <Cloud size={15} className="text-slate-500" />
                      <span className="flex-1">My Projects</span>
                    </button>
                    <button
                      onClick={() => { setIsAccountMenuOpen(false); setTokenShortfall(null); setIsTokensPanelOpen(true); }}
                      className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer"
                      role="menuitem"
                    >
                      <Coins size={15} className="text-slate-500" />
                      <span className="flex-1">Tokens</span>
                      <span className="text-[10px] font-bold text-slate-400 tabular-nums">
                        {accountBalance.status === 'ok' ? accountBalance.tokenBalance.toLocaleString() : '—'}
                      </span>
                    </button>
                    <button
                      onClick={() => { setIsAccountMenuOpen(false); setIsAccountPanelOpen(true); }}
                      className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer"
                      role="menuitem"
                    >
                      <Settings size={15} className="text-slate-500" />
                      <span className="flex-1">Account settings</span>
                    </button>
                    <button
                      onClick={() => { setIsAccountMenuOpen(false); firebaseSignOut(); }}
                      className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer"
                      role="menuitem"
                    >
                      <LogOut size={15} className="text-slate-500" />
                      <span className="flex-1">Sign out</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => setIsAuthModalOpen(true)}
                className="p-2 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100/80 transition-all flex items-center justify-center cursor-pointer"
                title="Sign In"
              >
                <LogIn size={20} />
              </button>
            )
          )}

          <div className="relative" ref={mainMenuRef}>
            <button
              onClick={() => {
                setIsImportExportMenuOpen(open => !open);
                setActiveSubmenu(null);
              }}
              className={`p-2 rounded-xl transition-all flex items-center justify-center cursor-pointer ${
                isImportExportMenuOpen
                  ? 'bg-slate-100 text-slate-900 shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
              }`}
              aria-haspopup="menu"
              aria-expanded={isImportExportMenuOpen}
              title="Menu"
            >
              <Menu size={20} />
            </button>

            {isImportExportMenuOpen && (
              <div 
                className="absolute right-0 top-full mt-2 w-56 rounded-2xl border border-slate-200/80 bg-white/95 backdrop-blur-xl p-1.5 shadow-2xl shadow-slate-900/12 z-[250] animate-in fade-in zoom-in-95 duration-100 select-none"
                role="menu"
              >
                {/* 1. Open Project */}
                <button
                  onClick={() => {
                    setIsImportExportMenuOpen(false);
                    setActiveSubmenu(null);
                    projectJsonFileInputRef.current?.click();
                  }}
                  className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer"
                  role="menuitem"
                  title="Open a project from an exported JSON file"
                >
                  <FolderOpen size={15} className="text-slate-500" />
                  <span className="flex-1">Open Project</span>
                </button>

                {isFirebaseConfigured && (
                  <button
                    onClick={() => {
                      setIsImportExportMenuOpen(false);
                      setActiveSubmenu(null);
                      if (currentUser) setIsProjectsPanelOpen(true);
                      else setIsAuthModalOpen(true);
                    }}
                    className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer"
                    role="menuitem"
                    title="Save or load a project from your account"
                  >
                    <Cloud size={15} className="text-slate-500" />
                    <span className="flex-1">My Projects (Cloud)</span>
                  </button>
                )}

                {/* 2. Import (with left flyout submenu) */}
                <div 
                  className="relative"
                  onMouseEnter={() => setActiveSubmenu('import')}
                  onMouseLeave={() => setActiveSubmenu(null)}
                >
                  <button
                    onClick={() => setActiveSubmenu(cur => cur === 'import' ? null : 'import')}
                    className={`w-full rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors flex items-center gap-2.5 cursor-pointer ${
                      activeSubmenu === 'import' ? 'bg-slate-100/90 text-slate-900' : 'text-slate-700 hover:bg-slate-100/90 hover:text-slate-900'
                    }`}
                    role="menuitem"
                    aria-haspopup="true"
                    aria-expanded={activeSubmenu === 'import'}
                  >
                    <Upload size={15} className="text-slate-500" />
                    <span className="flex-1">Import</span>
                    <ChevronRight size={13} className="text-slate-400" />
                  </button>

                  {activeSubmenu === 'import' && (
                    <div 
                      className="absolute right-full top-0 mr-1.5 w-56 rounded-2xl border border-slate-200/80 bg-white/95 backdrop-blur-xl p-1.5 shadow-2xl shadow-slate-900/12 z-[260] animate-in fade-in zoom-in-95 duration-100"
                      role="menu"
                    >
                      <button
                        onClick={() => {
                          setIsImportExportMenuOpen(false);
                          setActiveSubmenu(null);
                          run2DOnlyAction('dxf-import', () => dxfFileInputRef.current?.click());
                        }}
                        disabled={!is2DPlanActive}
                        className={`w-full rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors flex items-center gap-2.5 ${
                          is2DPlanActive ? 'text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 cursor-pointer' : 'text-slate-300 cursor-not-allowed opacity-60'
                        }`}
                        title={!is2DPlanActive ? 'CAD import is available in 2D Plan only' : 'Import an AutoCAD DXF into the 2D canvas'}
                        role="menuitem"
                      >
                        <Upload size={15} className={is2DPlanActive ? 'text-slate-500' : 'text-slate-300'} />
                        <span>CAD Import (.DXF)</span>
                      </button>

                      <button
                        onClick={() => {
                          setIsImportExportMenuOpen(false);
                          setActiveSubmenu(null);
                          run2DOnlyAction('bim-import', () => setIsBimImportWizardOpen(true));
                        }}
                        disabled={!is2DPlanActive}
                        className={`w-full rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors flex items-center gap-2.5 ${
                          is2DPlanActive ? 'text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 cursor-pointer' : 'text-slate-300 cursor-not-allowed opacity-60'
                        }`}
                        title={!is2DPlanActive ? 'BIM Importer is available in 2D Plan only' : 'Import an IFC model into native canvas elements'}
                        role="menuitem"
                      >
                        <Boxes size={15} className={is2DPlanActive ? 'text-slate-500' : 'text-slate-300'} />
                        <span>BIM Importer (.IFC)</span>
                      </button>

                      <button
                        onClick={() => {
                          setIsImportExportMenuOpen(false);
                          setActiveSubmenu(null);
                          run2DOnlyAction('aps-revit-import', () => setIsApsRevitImportDialogOpen(true));
                        }}
                        disabled={!is2DPlanActive}
                        className={`w-full rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors flex items-center gap-2.5 ${
                          is2DPlanActive ? 'text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 cursor-pointer' : 'text-slate-300 cursor-not-allowed opacity-60'
                        }`}
                        title={!is2DPlanActive ? 'Revit Importer is available in 2D Plan only' : 'Import an Autodesk Revit RVT file'}
                        role="menuitem"
                      >
                        <DatabaseZap size={15} className={is2DPlanActive ? 'text-slate-500' : 'text-slate-300'} />
                        <span>Revit Import (.RVT)</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* 3. Export (with left flyout submenu) */}
                <div 
                  className="relative"
                  onMouseEnter={() => setActiveSubmenu('export')}
                  onMouseLeave={() => setActiveSubmenu(null)}
                >
                  <button
                    onClick={() => setActiveSubmenu(cur => cur === 'export' ? null : 'export')}
                    className={`w-full rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors flex items-center gap-2.5 cursor-pointer ${
                      activeSubmenu === 'export' ? 'bg-slate-100/90 text-slate-900' : 'text-slate-700 hover:bg-slate-100/90 hover:text-slate-900'
                    }`}
                    role="menuitem"
                    aria-haspopup="true"
                    aria-expanded={activeSubmenu === 'export'}
                  >
                    <FileDown size={15} className="text-slate-500" />
                    <span className="flex-1">Export</span>
                    <ChevronRight size={13} className="text-slate-400" />
                  </button>

                  {activeSubmenu === 'export' && (
                    <div 
                      className="absolute right-full top-0 mr-1.5 w-56 rounded-2xl border border-slate-200/80 bg-white/95 backdrop-blur-xl p-1.5 shadow-2xl shadow-slate-900/12 z-[260] animate-in fade-in zoom-in-95 duration-100"
                      role="menu"
                    >
                      <button
                        onClick={() => {
                          setIsImportExportMenuOpen(false);
                          setActiveSubmenu(null);
                          handleExportProjectJson();
                        }}
                        className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer transition-colors"
                        title="Export full project data as JSON file"
                        role="menuitem"
                      >
                        <FileDown size={15} className="text-slate-500" />
                        <span>Download Project (.JSON)</span>
                      </button>

                      <button
                        onClick={() => {
                          setIsImportExportMenuOpen(false);
                          setActiveSubmenu(null);
                          setIsBimExportDialogOpen(true);
                        }}
                        className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer transition-colors"
                        title="Export the active project as a structured IFC BIM file"
                        role="menuitem"
                      >
                        <FileCode2 size={15} className="text-slate-500" />
                        <span>Export BIM (.IFC)</span>
                      </button>

                      <button
                        onClick={() => {
                          setIsImportExportMenuOpen(false);
                          setActiveSubmenu(null);
                          setIsRevitExportDialogOpen(true);
                        }}
                        className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer transition-colors"
                        title="Export as Revit RVT project via Autodesk Platform Services"
                        role="menuitem"
                      >
                        <HardDriveDownload size={15} className="text-slate-500" />
                        <span>Export Revit (.RVT)</span>
                      </button>

                      <button
                        onClick={() => {
                          setIsImportExportMenuOpen(false);
                          setActiveSubmenu(null);
                          handleVectorDxfExport();
                        }}
                        disabled={!is2DPlanActive}
                        className={`w-full rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors flex items-center gap-2.5 ${
                          is2DPlanActive ? 'text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 cursor-pointer' : 'text-slate-300 cursor-not-allowed opacity-60'
                        }`}
                        title={!is2DPlanActive ? 'CAD export is available in 2D Plan only' : 'Export the visible 2D plan as an AutoCAD DXF'}
                        role="menuitem"
                      >
                        <FileDown size={15} className={is2DPlanActive ? 'text-slate-500' : 'text-slate-300'} />
                        <span>Export CAD (.DXF)</span>
                      </button>

                      <button
                        onClick={() => {
                          setIsImportExportMenuOpen(false);
                          setActiveSubmenu(null);
                          run2DOnlyAction('vector-pdf-export', () => setIsPdfExportOpen(true));
                        }}
                        className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer transition-colors"
                        title={editorState.viewMode === '3D' ? 'Vector PDF export is available in 2D drawing views only' : 'Export the active 2D view as Vector PDF'}
                        role="menuitem"
                      >
                        <FileDown size={15} className="text-slate-500" />
                        <span>Export PDF</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Divider */}
                <div className="my-1 h-px bg-slate-100" />

                {/* 4. Save */}
                <button
                  onClick={() => {
                    setIsImportExportMenuOpen(false);
                    setActiveSubmenu(null);
                    handleSave();
                  }}
                  className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 flex items-center gap-2.5 cursor-pointer transition-colors"
                  role="menuitem"
                  title="Save current project"
                >
                  <Save size={15} className="text-slate-500" />
                  <span className="flex-1">Save</span>
                </button>

                {/* 5. Exit (earlier Home button) */}
                <button
                  onClick={() => {
                    setIsImportExportMenuOpen(false);
                    setActiveSubmenu(null);
                    setIsGenerativeWizardOpen(false);
                    setPendingDxfReview(null);
                    setPendingBimImportReview(null);
                    setPendingBimReview(null);
                    setProject(null);
                  }}
                  className="w-full rounded-xl px-3 py-2 text-left text-xs font-medium text-rose-600 hover:bg-rose-50 flex items-center gap-2.5 cursor-pointer transition-colors"
                  role="menuitem"
                  title="Exit to home screen"
                >
                  <LogOut size={15} className="text-rose-500" />
                  <span className="flex-1">Exit</span>
                </button>

                {/* Divider */}
                <div className="my-1 h-px bg-slate-100" />

                {/* 6. Build */}
                <div className="w-full px-3 py-1.5 text-[10px] text-slate-400 flex items-center justify-between select-none">
                  <div className="flex items-center gap-1.5 font-medium">
                    <Hammer size={12} className="text-slate-400" />
                    <span>Build</span>
                  </div>
                  <span className="font-mono text-[9px] text-slate-400/80 truncate max-w-[110px]" title={buildVersion}>
                    {buildVersion}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      
      <div className="flex-1 flex overflow-hidden relative">
        {showSaveFeedback && <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-green-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 animate-bounce"><CheckCircle2 size={16} /> Saved Successfully</div>}

        <div className="flex-1 relative overflow-hidden flex flex-col bg-slate-100">
          {project && (
            <div className="absolute top-[56px] right-5 z-40 pointer-events-none">
              <ViewportCompass
                canvasAngle={editorState.canvasAngle || 0}
                onAngleChange={(angle) => setEditorState(s => ({ ...s, canvasAngle: angle }))}
                viewMode={editorState.viewMode}
                onToggleViewMode={switchViewMode}
                activeDrawingView={activeDrawingView}
                onSelectDrawingView={switchDrawingView}
                onSnap3DCamera={(dir) => {
                  window.dispatchEvent(new CustomEvent('snap-3d-camera', { detail: dir }));
                }}
                elements={project.elements}
                isParallel={isParallel3D}
                onToggleParallel={() => {
                  const nextVal = !isParallel3D;
                  setIsParallel3D(nextVal);
                  window.dispatchEvent(new CustomEvent('toggle-3d-projection', { detail: nextVal }));
                }}
              />
            </div>
          )}
          {layoutWarnings.length > 0 && (
            <div className="absolute top-4 right-4 z-40 max-w-sm space-y-2 pointer-events-none">
              {layoutWarnings.map((warn, i) => (
                <div key={i} className="bg-amber-50 border-l-4 border-amber-400 p-3 shadow-md animate-in slide-in-from-right rounded-r-lg pointer-events-auto">
                  <div className="flex items-start">
                    <div className="flex-shrink-0">
                      <Sparkles size={16} className="text-amber-500" />
                    </div>
                    <div className="ml-3">
                      <p className="text-xs font-medium text-amber-800">{warn}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {project && (
            <>
              {(() => {
                const uiActiveTool = (editorState.activeTool === 'select' && editorState.isDraggingSelected) 
                  ? 'move' 
                  : editorState.activeTool;
                
                return (
                  <>
                    <Toolbox 
                      position={toolboxPos} 
                      onPositionChange={setToolboxPos} 
                      activeTool={uiActiveTool} 
                      selectedCount={(editorState.selectedIds || []).length} 
                      hasOpeningSelected={hasOpeningSelected} 
                      hasElevationSelected={hasElevationSelected} 
                      hasWallSelected={hasWallSelected} 
                      onToolSelect={handleToolSelect} 
                      onUndo={onUndo} 
                      onRedo={onRedo} 
                      onRotate={onRotate} 
                      onMirror={onMirror} 
                      onGroup={onGroup}
                      onUngroup={onUngroup}
                      isSingleGroupSelected={isSingleGroupSelected}
                      onFitToView={onFitToView} 
                    />
                    <DrawBar 
                      position={drawBarPos} 
                      onPositionChange={setToolboxDrawBarPos} 
                      activeTool={uiActiveTool} 
                      isWallMode={editorState.isWallMode} 
                      onToolSelect={handleToolSelect} 
                      mode={project!.mode} 
                      disabledToolIds={editorState.viewMode === '3D' ? VIEW_POLICY_2D_ONLY_TOOL_IDS : (isElevationActive ? new Set([...ELEVATION_DISABLED_DRAW_TOOLS, ...VIEW_POLICY_3D_ONLY_TOOL_IDS]) : VIEW_POLICY_3D_ONLY_TOOL_IDS)}
                      customInteriorPresets={customRevitPresets}
                      onOpen3DGenerator={() => run2DOnlyAction('ai-generation', () => {
                        setGenerativeInitialMode('ai-rendering');
                        setGenerativeInitialHub('gen_3d');
                        setIsGenerativeWizardOpen(true);
                      })}
                    />
                  </>
                );
              })()}
              <SnapBar 
                position={snapBarPos} 
                onPositionChange={setToolboxSnapBarPos} 
                isOrtho={editorState.isOrthoEnabled} 
                toggleOrtho={() => setEditorState(s => ({ ...s, isOrthoEnabled: !s.isOrthoEnabled }))} 
                isGrid={editorState.isGridVisible} 
                toggleGrid={() => setEditorState(s => ({ ...s, isGridVisible: !s.isGridVisible }))} 
                isSnap={editorState.isSnapEnabled} 
                toggleSnap={() => setEditorState(s => ({ ...s, isSnapEnabled: !s.isSnapEnabled }))} 
                isEndpoint={editorState.isEndpointSnap} 
                toggleEndpoint={() => setEditorState(s => ({ ...s, isEndpointSnap: !s.isEndpointSnap }))} 
                isMidpoint={editorState.isMidpointSnap} 
                toggleMidpoint={() => setEditorState(s => ({ ...s, isMidpointSnap: !s.isMidpointSnap }))} 
                isIntersection={editorState.isIntersectionSnap} 
                toggleIntersection={() => setEditorState(s => ({ ...s, isIntersectionSnap: !s.isIntersectionSnap }))} 
                isPointAlignment={editorState.isPointAlignmentSnap} 
                togglePointAlignment={() => setEditorState(s => ({ ...s, isPointAlignmentSnap: !s.isPointAlignmentSnap }))} 
                isAngularAlignment={editorState.isAngularAlignmentSnap} 
                toggleAngularAlignment={() => setEditorState(s => ({ ...s, isAngularAlignmentSnap: !s.isAngularAlignmentSnap }))} 
                hasSiteMap={!!project?.siteMap?.url}
                onOpenSiteMapPanel={() => setIsSiteMapPanelOpen(true)}
              />
              <div className="absolute top-[224px] right-5 bottom-5 flex flex-col gap-4 items-end z-40 pointer-events-none">
                <PropertiesPanel 
                  selectedElement={project?.elements.find(el => editorState.selectedIds.includes(el.id)) || null} 
                  onUpdate={handleElementUpdate} 
                  onUpdateProjectSettings3D={handleProjectSettings3DCommit} 
                  editorState={editorState} 
                  setEditorState={setEditorState} 
                  project={project!} 
                  setProject={setProject}
                  onRegenerateProcedural={handleRegenerateProcedural} 
                  onOpenProceduralWizard={(hostId, boundary) => {
                      if (!require2DAction('procedural-boundary')) return;
                      const host = project?.elements.find(e => e.id === hostId);
                      if (host?.isAutoProceduralHost) {
                          setGenerativeInitialMode('auto-procedural');
                          setIsGenerativeWizardOpen(true);
                      } else if (host?.isSmartProceduralHost) {
                          setSmartProceduralWizardData({ hostId, boundary });
                          setIsSmartProceduralWizardOpen(true);
                      } else {
                          setProceduralWizardData({ hostId, boundary });
                          setIsProceduralWizardOpen(true);
                      }
                  }}
                  onFurnishFloor={handleFurnishFloor}
                  onUpdateProjectLayers={handleUpdateLayers}
                  onOpenUrbanWizard={() => run2DOnlyAction('urban-generation', () => setIsUrbanWizardOpen(true))}
                  onOpenGenerativeWizard={() => run2DOnlyAction('ai-generation', () => {
                    setGenerativeInitialMode('chat');
                    setIsGenerativeWizardOpen(true);
                  })}
                />
              </div>
            </>
          )}

          {project && (
            editorState.viewMode === '2D' ? (
              <Canvas 
                ref={canvasRef}
                project={{ ...project, elements: activeProjectElements }} 
                activeLevelId={editorState.activeLevelId} 
                editorState={editorState} 
                onElementsChange={handleElementsChange} 
                onElementsCommit={handleElementsCommit} 
                onSelectionChange={onSelectionChange} 
                onTransformChange={handleTransform} 
                setEditorState={setEditorState} 
                activeProceduralConfig={activeProceduralConfig}
                placingImportedElements={placingImportedElements}
                onDropImportedElements={(elements) => {
                  if (!project) return;
                  const nextElements = [...project.elements];
                  const idMap = new Map(elements.map(el => [el.id, crypto.randomUUID()]));
                  // Remap the complete generated set first. Hosted openings must reference
                  // the newly inserted wall IDs, never their Design Copilot preview IDs.
                  const remappedElements: ArchElement[] = elements.map(el => {
                    const nextId = idMap.get(el.id) || crypto.randomUUID();
                    return {
                      ...el,
                      id: nextId,
                      hostWallId: el.hostWallId ? (idMap.get(el.hostWallId) || el.hostWallId) : el.hostWallId,
                      groupId: el.groupId ? (idMap.get(el.groupId) || el.groupId) : el.groupId,
                    };
                  });

                  const insertedWallMap = new Map<string, ArchElement>(
                    remappedElements.filter(el => el.type === 'wall').map(el => [el.id, el])
                  );
                  const normalizeLegacyHostedElement = (el: ArchElement) => {
                    if (!['door', 'window', 'wall-opening'].includes(el.type) || !el.hostWallId) return el;
                    const wall = insertedWallMap.get(el.hostWallId);
                    if (!wall?.p1 || !wall.p2) return el;
                    const t = Math.max(0, Math.min(1, el.hostT ?? 0.5));
                    const dx = wall.p2.x - wall.p1.x;
                    const dy = wall.p2.y - wall.p1.y;
                    return {
                      ...el,
                      hostT: t,
                      pos: { x: wall.p1.x + dx * t, y: wall.p1.y + dy * t },
                      rotation: Math.atan2(dy, dx) * 180 / Math.PI,
                    };
                  };
                  // Text 4.0 F/G/H/J Design Copilot payloads are already the final
                  // digitization. Preserve it exactly through placement; the
                  // legacy straight-chord host normalizer is only for older,
                  // non-authoritative imports.
                  const faithfullyHostedElements = isText4jAuthoritativePreview(remappedElements)
                    ? finalizeText4jImportHandoff(remappedElements, normalizeLegacyHostedElement)
                    : isText4hAuthoritativePreview(remappedElements)
                    ? finalizeText4hImportHandoff(remappedElements, normalizeLegacyHostedElement)
                    : isText4gAuthoritativePreview(remappedElements)
                      ? finalizeText4gImportHandoff(remappedElements, normalizeLegacyHostedElement)
                      : isText4fAuthoritativePreview(remappedElements)
                      ? finalizeText4fImportHandoff(remappedElements, normalizeLegacyHostedElement)
                      : finalizeText4dImportHandoff(remappedElements, normalizeLegacyHostedElement);
                  nextElements.push(...faithfullyHostedElements);
                  
                  let nextLevels = placingImportedLevels || project.levels;
                  nextLevels = [...nextLevels].sort((a, b) => a.order - b.order);

                  const newProject = { 
                    ...project, 
                    levels: nextLevels, 
                    elements: nextElements, 
                    mode: project.mode || 'floorplan' 
                  };
                  setProject(newProject);
                  pushHistory(newProject);
                  setPlacingImportedElements(null);
                  setPlacingImportedLevels(null);
                }}
                onCancelImportedElements={() => {
                  setPlacingImportedElements(null);
                  setPlacingImportedLevels(null);
                }}
              />
            ) : (
              <Viewer3D
                project={project}
                editorState={editorState}
                activeLevelId={editorState.activeLevelId}
                onElementsChange={handleElementsChange}
                onElementsCommit={handleElementsCommit}
                onSelectionChange={onSelectionChange}
                setEditorState={setEditorState}
                initialCameraFrame={viewportFramesRef.current['3D']}
                onCameraFrameChange={(frame) => { viewportFramesRef.current['3D'] = frame; }}
              />
            )
          )}
        </div>

        {project?.mode === 'urban' && (
          <UrbanDashboard 
            project={project} 
            onGenerateParcels={() => {
              const boundary = getCurrentBoundary();
              if (!boundary) return;
              const parcels = UrbanGeneratorService.generateParcels(boundary);
              const nextProject = { ...project, elements: [...project.elements, ...parcels] };
              setProject(nextProject);
              pushHistory(nextProject);
            }}
            onOpenUrbanWizard={() => run2DOnlyAction('urban-generation', () => setIsUrbanWizardOpen(true))}
          />
        )}
      </div>      {/* Snap Preview Popup */}
      {snapPreviewImage && (
        <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-2xl z-[9999] p-4 flex flex-col w-[400px]">
          <h3 className="text-sm font-bold text-slate-800 mb-2 flex items-center justify-between">
            <span>Screenshot Captured</span>
            <button onClick={() => setSnapPreviewImage(null)} className="text-slate-400 hover:text-slate-600"><CloseIcon size={16}/></button>
          </h3>
          <div className="w-full h-48 bg-slate-100 rounded border border-slate-200 overflow-hidden mb-4 relative">
            <img src={snapPreviewImage} className="w-full h-full object-cover" />
          </div>
          <div className="flex gap-2 justify-end">
            <button 
              onClick={() => setSnapPreviewImage(null)}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-md"
            >
              Discard
            </button>
            <button 
              onClick={() => {
                const now = new Date();
                const ts = now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
                setPendingSnapshots(s => [...s, { url: snapPreviewImage, name: `Snap ${ts}` }]);
                setSnapPreviewImage(null);
              }}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md"
            >
              Import to Render Canvas
            </button>
          </div>
        </div>
      )}

      <GenerativeWizard 
        isOpen={isGenerativeWizardOpen} 
        onClose={() => {
          setIsGenerativeWizardOpen(false);
          setPendingDxfReview(null);
          setPendingBimImportReview(null);
          setPendingBimReview(null);
        }}
        onApply={handleGenerativeApply}
        canvasProjectTemplate={project}
        initialMode={generativeInitialMode}
        initialAiRenderingHub={generativeInitialHub}
        initialText4hImageTest={generativeInitialText4hImageTest}
        externalImport={pendingDxfExternalImport || pendingBimImportExternalImport || pendingBimExternalImport}
        onApplyExternalImport={handleApplyDxfFromCopilot}
        currentBoundary={getCurrentBoundary()}
        unitSystem={editorState.unitSystem}
        onChangeUnitSystem={(unit) => setEditorState(prev => ({ ...prev, unitSystem: unit }))}
        onLoadBimToInventory={handleRegisterBimAsset}
        initialSnapshots={pendingSnapshots}
        onSnapshotsConsumed={() => setPendingSnapshots([])}
      />

      <RevitImportWizard
        isOpen={isRevitWizardOpen}
        onClose={() => setIsRevitWizardOpen(false)}
        onLoadToInventory={(asset) => {
          setPendingBimReview(asset);
          setIsGenerativeWizardOpen(true);
        }}
        onLoadProjectLayout={handleLoadRvtProjectLayout}
      />

      <BimImporterWizard
        isOpen={isBimImportWizardOpen}
        onClose={() => setIsBimImportWizardOpen(false)}
        onSessionReady={(session) => {
          setPendingBimImportReview(session);
          setIsBimImportWizardOpen(false);
          setIsGenerativeWizardOpen(true);
          setEditorState(state => ({ ...state, viewMode: '2D', drawingView: 'plan', activeTool: 'select', selectedIds: [] }));
        }}
      />

      <ApsRevitImporterDialog
        isOpen={isApsRevitImportDialogOpen}
        onClose={() => setIsApsRevitImportDialogOpen(false)}
        onImportComplete={handleApsRevitImportComplete}
      />

      {project && isBimExportDialogOpen && (
        <BimExporterDialog
          isOpen={isBimExportDialogOpen}
          project={project}
          unitSystem={editorState.unitSystem}
          activeLevelId={editorState.activeLevelId}
          onClose={() => setIsBimExportDialogOpen(false)}
          onExportComplete={handleBimExportComplete}
        />
      )}

      {project && isRevitExportDialogOpen && (
        <RevitExporterDialog
          isOpen={isRevitExportDialogOpen}
          project={project}
          unitSystem={editorState.unitSystem}
          activeLevelId={editorState.activeLevelId}
          onClose={() => setIsRevitExportDialogOpen(false)}
          onJobUpdate={handleRevitExportJobUpdate}
        />
      )}

      <UrbanWizard
        isOpen={isUrbanWizardOpen}
        onClose={() => setIsUrbanWizardOpen(false)}
        onApply={handleUrbanApply}
      />

      <ProceduralWizard
        isOpen={isProceduralWizardOpen}
        onClose={() => setIsProceduralWizardOpen(false)}
        onApply={(config) => {
            if (!require2DAction('procedural-boundary')) return;
            if (proceduralWizardData?.hostId) {
                handleRegenerateProcedural(proceduralWizardData.hostId, proceduralWizardData.boundary, config);
            } else {
                setActiveProceduralConfig(config);
                if (pendingProceduralTool) {
                    setEditorState(s => ({ ...s, activeTool: pendingProceduralTool }));
                }
            }
        }}
        initialConfig={(() => {
            if (proceduralWizardData?.hostId) {
                const host = project?.elements.find(e => e.id === proceduralWizardData.hostId);
                if (host) {
                    const typologyObj = PROCEDURAL_TYPOLOGIES.find(t => t.programId === host.proceduralProgramId) || PROCEDURAL_TYPOLOGIES[0];
                    return {
                        typology: typologyObj.id,
                        subtype: host.subType || typologyObj.subtypes[0],
                        style: (host.proceduralTypology as any) || 'Standard',
                        geometry: (host.proceduralGeometry as any) || 'Rectilinear',
                        requirements: host.proceduralRequirements || {},
                        globals: {
                            privacyPriority: (host.proceduralRequirements as any)?.privacyPriority || 'medium',
                            circulationPreference: (host.proceduralRequirements as any)?.circulationPreference || 'compact',
                            includeCourtyard: (host.proceduralRequirements as any)?.includeCourtyard || false
                        }
                    };
                }
            }
            return activeProceduralConfig || undefined;
        })()}
      />

      <SmartProceduralWizard
        isOpen={isSmartProceduralWizardOpen}
        onClose={() => setIsSmartProceduralWizardOpen(false)}
        onApply={(config) => {
            if (!require2DAction('smart-procedural-boundary')) return;
            if (smartProceduralWizardData?.hostId) {
                handleRegenerateProcedural(smartProceduralWizardData.hostId, smartProceduralWizardData.boundary, { ...config, isSmartProcedural: true });
            } else {
                setActiveProceduralConfig({ ...config, isSmartProcedural: true });
                if (pendingProceduralTool) {
                    setEditorState(s => ({ ...s, activeTool: pendingProceduralTool }));
                }
            }
        }}
        initialConfig={(() => {
            if (smartProceduralWizardData?.hostId) {
                const host = project?.elements.find(e => e.id === smartProceduralWizardData.hostId);
                if (host) {
                    const typologyObj = PROCEDURAL_TYPOLOGIES.find(t => t.programId === host.proceduralProgramId) || PROCEDURAL_TYPOLOGIES[0];
                    return {
                        typology: typologyObj.id,
                        subtype: host.subType || typologyObj.subtypes[0],
                        style: (host.proceduralTypology as any) || 'Standard',
                        geometry: (host.proceduralGeometry as any) || 'Rectilinear',
                        requirements: host.proceduralRequirements || {},
                        globals: {
                            privacyPriority: (host.proceduralRequirements as any)?.privacyPriority || 'medium',
                            circulationPreference: (host.proceduralRequirements as any)?.circulationPreference || 'compact',
                            includeCourtyard: (host.proceduralRequirements as any)?.includeCourtyard || false
                        }
                    };
                }
            }
            return activeProceduralConfig || undefined;
        })()}
      />

      {isSiteMapPanelOpen && project && (
        <SiteMapPanel 
          project={project}
          isVisible={editorState.isSiteMapVisible}
          onToggleVisibility={() => setEditorState(s => ({ ...s, isSiteMapVisible: !s.isSiteMapVisible }))}
          onUpdateSiteMap={handleUpdateSiteMap}
          onUploadMap={handleMapUpload}
          onClose={() => setIsSiteMapPanelOpen(false)}
        />
      )}

      {/* Mirror Axis Floating Buttons */}
      {showMirrorOptions && editorState.selectedIds.length > 0 && (
        <div 
          className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur-md px-4 py-3 rounded-2xl shadow-2xl border border-slate-200 z-[60] flex items-center gap-4 animate-in slide-in-from-bottom-4 duration-300 pointer-events-auto"
        >
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Mirror Axis</span>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => onMirror('horizontal')}
                className="flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-blue-50 text-slate-700 hover:text-blue-700 rounded-xl transition-all border border-slate-200 hover:border-blue-200 group"
              >
                <GripVertical size={16} className="text-slate-400 group-hover:text-blue-500" />
                <span className="text-sm font-semibold">Horizontal</span>
              </button>
              <button 
                onClick={() => onMirror('vertical')}
                className="flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-blue-50 text-slate-700 hover:text-blue-700 rounded-xl transition-all border border-slate-200 hover:border-blue-200 group"
              >
                <GripHorizontal size={16} className="text-slate-400 group-hover:text-blue-500" />
                <span className="text-sm font-semibold">Vertical</span>
              </button>
              <div className="w-px h-8 bg-slate-200 mx-1" />
              <button 
                onClick={() => setShowMirrorOptions(false)}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all"
                title="Cancel"
              >
                <ChevronLeft size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      <SiteImportWizard
        isOpen={isSiteImportWizardOpen}
        onClose={() => setIsSiteImportWizardOpen(false)}
        onImport={handleSiteImport}
      />
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />
      {currentUser && (
        <ProjectsPanel
          isOpen={isProjectsPanelOpen}
          onClose={() => setIsProjectsPanelOpen(false)}
          userId={currentUser.uid}
          currentProject={project}
          currentProjectId={currentProjectId}
          onLoadProject={(loadedProject, projectId) => {
            setProject(loadedProject);
            setCurrentProjectId(projectId);
          }}
          onProjectSaved={(projectId, name) => {
            setCurrentProjectId(projectId);
            setProject(prev => (prev && prev.name !== name ? { ...prev, name } : prev));
          }}
        />
      )}
      {currentUser && (
        <AccountPanel
          isOpen={isAccountPanelOpen}
          onClose={() => setIsAccountPanelOpen(false)}
          user={currentUser}
        />
      )}
      {currentUser && (
        <TokensPanel
          isOpen={isTokensPanelOpen}
          onClose={() => { setIsTokensPanelOpen(false); setTokenShortfall(null); }}
          user={currentUser}
          balance={accountBalance}
          shortfall={tokenShortfall}
        />
      )}
      <PdfExportDialog
        isOpen={isPdfExportOpen}
        projectName={project?.name || 'plan'}
        onClose={() => setIsPdfExportOpen(false)}
        onExport={handleVectorPdfExport}
      />
      {dxfImportUnitsDialog}
      
      {dxfImportSummary && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[300] animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 animate-in zoom-in duration-300" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">DXF Import Successful</h3>
                  <p className="text-xs text-slate-500">Geometry scale: {dxfImportSummary.unitSource}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-4 rounded-2xl border border-slate-100 mb-6">
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Walls Detected</span>
                  <span className="text-base font-bold text-slate-800">{dxfImportSummary.walls}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Loose Lines</span>
                  <span className="text-base font-bold text-slate-800">{dxfImportSummary.lines - dxfImportSummary.walls * 2}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Arcs</span>
                  <span className="text-base font-bold text-slate-800">{dxfImportSummary.arcs}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Circles</span>
                  <span className="text-base font-bold text-slate-800">{dxfImportSummary.circles}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Text Items</span>
                  <span className="text-base font-bold text-slate-800">{dxfImportSummary.text}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Layers</span>
                  <span className="text-base font-bold text-slate-800">{dxfImportSummary.layers}</span>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => setDxfImportSummary(null)}
                  className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold rounded-xl transition-all shadow-md active:scale-95 cursor-pointer"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingConvert3dId && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[10000] flex items-center justify-center p-6">
          <div className="bg-white rounded-3xl max-w-lg w-full p-8 shadow-2xl border border-slate-100 flex flex-col items-center text-center space-y-6 animate-in fade-in zoom-in duration-200">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-600">
              <Sparkles size={32} />
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-slate-800">Clean Drawing for 3D View</h3>
              <p className="text-sm text-slate-500 leading-relaxed">
                Would you like to remove unnecessary parts (like annotations, dimensions, or loose lines) from the imported drawing before converting and displaying it in 3D?
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3 w-full pt-2">
              <button
                onClick={() => handleConfirmConvert3d(true)}
                className="flex-1 py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-bold rounded-xl transition-all shadow-md active:scale-98 cursor-pointer border border-amber-600"
              >
                Removed, Convert 3D
              </button>
              <button
                onClick={() => handleConfirmConvert3d(false)}
                className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-all border border-slate-250 cursor-pointer"
              >
                To Remove, Open Canvas
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
