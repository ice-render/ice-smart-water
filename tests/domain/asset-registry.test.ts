/**
 * 设备资产台账：单元 → 台账一一对应 + 派生字段的确定性与合理区间。
 */
import { SEWAGE_PLANT } from '../../src/domain/plant-case';
import { SYMBOL_CATALOG } from '../../src/domain/symbol-catalog';
import {
  ASSET_CATEGORY_LABELS,
  HEALTH_DIMS,
  assetHealthMatrix,
  assetKpi,
  assetRows,
  buildAssetRegistry,
  hashOf,
  healthBand,
  maintenanceDue,
} from '../../src/domain/asset-registry';

const assets = () => buildAssetRegistry();

describe('hashOf：稳定散列', () => {
  it('同输入同结果、落在 [0,1)、不同输入一般不同', () => {
    expect(hashOf('ae-1')).toBe(hashOf('ae-1'));
    expect(hashOf('ae-1')).toBeGreaterThanOrEqual(0);
    expect(hashOf('ae-1')).toBeLessThan(1);
    expect(hashOf('ae-1')).not.toBe(hashOf('ae-2'));
  });
});

describe('台账：图上的单元 ↔ 账上的设备', () => {
  it('台账条数 = 非边界单元数（边界标记不算设备）', () => {
    const expected = SEWAGE_PLANT.units.filter((unit) => {
      const entry = SYMBOL_CATALOG[unit.kind];
      return !!entry && String(entry.category) !== 'boundary';
    }).length;
    expect(assets()).toHaveLength(expected);
  });

  it('每条台账都能对应回一个单元（位号 / 名称 / id 一致）', () => {
    assets().forEach((asset) => {
      const unit = SEWAGE_PLANT.units.filter((item) => item.id === asset.id)[0];
      expect(unit).toBeTruthy();
      expect(asset.tag).toBe(unit.tag);
      expect(asset.name).toBe(unit.name);
    });
  });

  it('确定性：两次构建结果完全一致（e2e 可复现的前提）', () => {
    expect(assets()).toEqual(assets());
  });

  it('字段落在合理区间：健康度 0~100、可用率 (0,1)、MTBF > MTTR', () => {
    assets().forEach((asset) => {
      expect(asset.health).toBeGreaterThanOrEqual(40);
      expect(asset.health).toBeLessThanOrEqual(100);
      expect(asset.healthByDim).toHaveLength(HEALTH_DIMS.length);
      asset.healthByDim.forEach((score) => {
        expect(score).toBeGreaterThanOrEqual(40);
        expect(score).toBeLessThanOrEqual(100);
      });
      expect(asset.availability).toBeGreaterThan(0);
      expect(asset.availability).toBeLessThanOrEqual(1);
      expect(asset.mtbfH).toBeGreaterThan(asset.mttrH);
      expect(asset.commissionedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(asset.maintenance.nextAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe('KPI 与分档', () => {
  it('各率落在 0~1，计数与台账一致', () => {
    const list = assets();
    const kpi = assetKpi(list);
    expect(kpi.total).toBe(list.length);
    expect(kpi.intactRate).toBeGreaterThanOrEqual(0);
    expect(kpi.intactRate).toBeLessThanOrEqual(1);
    expect(kpi.availability).toBeGreaterThan(0);
    expect(kpi.availability).toBeLessThanOrEqual(1);
    expect(kpi.maintenanceRate).toBeGreaterThanOrEqual(0);
    expect(kpi.spareRate).toBeGreaterThanOrEqual(0);
    expect(kpi.risky).toBe(list.filter((asset) => asset.health < 70).length);
  });

  it('健康度分档：≥85 良好 / ≥70 关注 / 其余预警', () => {
    expect(healthBand(92).label).toBe('良好');
    expect(healthBand(75).label).toBe('关注');
    expect(healthBand(60).label).toBe('预警');
  });

  it('热力图矩阵：横轴=分类、纵轴=维度，值 0~100', () => {
    const list = assets();
    const matrix = assetHealthMatrix(list);
    const categories = Object.keys(ASSET_CATEGORY_LABELS).filter((key) =>
      list.some((asset) => asset.category === key)
    );
    expect(matrix).toHaveLength(HEALTH_DIMS.length * categories.length);
    matrix.forEach(([category, dim, value]) => {
      expect(HEALTH_DIMS).toContain(dim);
      expect(categories.map((key) => ASSET_CATEGORY_LABELS[key])).toContain(category);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    });
  });

  it('到期维保：都是「已到期且未完成」', () => {
    maintenanceDue(assets()).forEach((asset) => {
      expect(asset.maintenance.due).toBe(true);
      expect(asset.maintenance.done).toBe(false);
    });
  });

  it('表格行：列 key 齐全', () => {
    const rows = assetRows(assets());
    expect(rows.length).toBeGreaterThan(0);
    ['id', 'tag', 'name', 'model', 'vendor', 'commissionedAt', 'health', 'band', 'nextAt'].forEach((key) =>
      expect(Object.keys(rows[0])).toContain(key)
    );
  });
});
