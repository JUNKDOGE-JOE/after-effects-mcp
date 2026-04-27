"""AEBMethod file-bridge backend implementation."""
from ae_mcp.backends.base import Backend


class AEBMBackend(Backend):
    name = "aebm"
    manages_undo = False
    manages_checkpoints = False

    async def exec(self, code, *, undo_group=None, checkpoint_label=None, timeout_sec=30.0):
        raise NotImplementedError("populated in Task 3.2")

    async def health_check(self, timeout_sec=5.0):
        raise NotImplementedError("populated in Task 3.2")

    @classmethod
    def from_env(cls):
        raise NotImplementedError("populated in Task 3.2")
