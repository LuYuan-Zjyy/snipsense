import { describe, expect, it } from 'vitest';
import { buildCallGraph, type CallSourceFile } from '../src/core/call-graph';

const sources: CallSourceFile[] = [
  {
    path: 'layer.py',
    language: 'python',
    text: [
      'import torch',
      '',
      'class PPEmb(torch.nn.Module):',
      '    def __init__(self, dim):',
      '        super().__init__()',
      '        self.proj = torch.nn.Linear(dim, dim)',
      '',
      '    def forward(self, x):',
      '        return self.proj(x)',
      '',
      'class Block(torch.nn.Module):',
      '    def __init__(self, dim):',
      '        self.attn = PPEmb(dim)',
      '',
      '    def forward(self, x):',
      '        return self.attn.forward(x)',
    ].join('\n'),
  },
  {
    path: 'vit.py',
    language: 'python',
    text: [
      'from layer import PPEmb, Block',
      '',
      'class ViT(torch.nn.Module):',
      '    def __init__(self, dim):',
      '        self.ppe = PPEmb(dim)',
      '        self.blocks = Block(dim)',
      '',
      '    def forward(self, x):',
      '        x = self.ppe.forward(x)',
      '        return self.blocks.forward(x)',
      '',
      'def train():',
      '    model = ViT(128)',
      '    return model.forward(1)',
    ].join('\n'),
  },
];

describe('buildCallGraph', () => {
  it('builds Python functions and methods', () => {
    const graph = buildCallGraph(sources, 'vit.py');
    const ids = graph.nodes.map((node) => node.id);
    expect(ids).toContain('vit.py#ViT.__init__');
    expect(ids).toContain('layer.py#PPEmb.__init__');
    expect(ids).toContain('layer.py#PPEmb.forward');
    expect(ids).toContain('vit.py#train');
    expect(graph.focus).toBe('vit.py#ViT.__init__');
  });

  it('resolves constructors and self.attribute method calls', () => {
    const graph = buildCallGraph(sources, 'vit.py');
    const edges = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);

    expect(edges).toContain('vit.py#ViT.__init__ -> layer.py#PPEmb.__init__');
    expect(edges).toContain('vit.py#ViT.__init__ -> layer.py#Block.__init__');
    expect(edges).toContain('vit.py#ViT.forward -> layer.py#PPEmb.forward');
    expect(edges).toContain('vit.py#ViT.forward -> layer.py#Block.forward');
    expect(edges).toContain('layer.py#Block.__init__ -> layer.py#PPEmb.__init__');
    expect(edges).toContain('vit.py#train -> vit.py#ViT.__init__');
  });

  it('does not resolve external library calls', () => {
    const graph = buildCallGraph(sources, 'vit.py');
    const edges = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);
    expect(edges.some((edge) => edge.includes('torch'))).toBe(false);
    expect(edges.some((edge) => edge.includes('nn.'))).toBe(false);
  });
});
