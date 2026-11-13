from torch import nn


class PPEmb(nn.Module):
    def __init__(self, img_size, patch_size):
        super().__init__()
        self.img_size = img_size
        self.patch_size = patch_size
