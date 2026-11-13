import torch
from layer import PPEmb

class ViT(torch.nn.Module):
    def __init__(self, img_size, patch_size, dim):
        super().__init__()
        self.ppe = PPEmb(img_size, patch_size)
