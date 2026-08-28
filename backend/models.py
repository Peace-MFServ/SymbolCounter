from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey, Text, JSON, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


# ── Default symbol types ───────────────────────────────────────────────────────
DEFAULT_SYMBOL_TYPES = [
    # Security
    {"name": "Audio Intercom",       "code": "AIS",        "color": "#22c55e", "sort_order": 0},
    {"name": "CCTV Dome Camera",     "code": "CCTV_Dome",  "color": "#3b82f6", "sort_order": 1},
    {"name": "CCTV Fixed Camera",    "code": "CCTV_Fixed", "color": "#60a5fa", "sort_order": 2},
    {"name": "Access Control Door",  "code": "AC",         "color": "#f97316", "sort_order": 3},
    {"name": "Input/Output Device",  "code": "I/O",        "color": "#a78bfa", "sort_order": 4},
    # Fire alarm
    {"name": "Smoke Detector",             "code": "S",    "color": "#e11d48", "sort_order": 5},
    {"name": "Heat Detector",              "code": "H",    "color": "#b91c1c", "sort_order": 6},
    {"name": "Manual Call Point",          "code": "MCP",  "color": "#dc2626", "sort_order": 7},
    {"name": "Fire Alarm Sounder",         "code": "SND",  "color": "#d97706", "sort_order": 8},
    {"name": "Fire Alarm Panel",           "code": "FAP",  "color": "#7c2d12", "sort_order": 9},
    {"name": "Fire Alarm Repeater Panel",  "code": "FARP", "color": "#a16207", "sort_order": 10},
]


# ── User ──────────────────────────────────────────────────────────────────────
class User(Base):
    __tablename__ = "users"
    id               = Column(Integer, primary_key=True, index=True)
    email            = Column(String, unique=True, index=True, nullable=False)
    name             = Column(String, nullable=False)
    hashed_password  = Column(String, nullable=False)
    is_active        = Column(Boolean, default=True)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    projects         = relationship("Project", back_populates="owner")
    templates        = relationship("GlobalTemplate", back_populates="created_by_user")


# ── Global template library ───────────────────────────────────────────────────
class GlobalTemplate(Base):
    """
    A single cropped example image of a symbol, stored globally.
    Multiple instances per symbol code = better matching accuracy.
    """
    __tablename__ = "global_templates"
    id                   = Column(Integer, primary_key=True, index=True)
    symbol_code          = Column(String, nullable=False, index=True)
    symbol_name          = Column(String, default="")
    image_path           = Column(String, nullable=False)
    image_width          = Column(Integer, default=0)
    image_height         = Column(Integer, default=0)
    # Feedback stats — updated as users verify detections
    use_count            = Column(Integer, default=0)
    confirm_count        = Column(Integer, default=0)
    reject_count         = Column(Integer, default=0)
    # Context for prioritisation
    drawing_firm         = Column(String, default="")
    drawing_scale        = Column(String, default="")
    source_project_id    = Column(Integer, ForeignKey("projects.id"), nullable=True)
    created_by_id        = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at           = Column(DateTime(timezone=True), server_default=func.now())
    # Relationships
    created_by_user      = relationship("User", back_populates="templates")
    feedbacks            = relationship("DetectionFeedback", back_populates="template")

    @property
    def effective_threshold(self) -> float:
        """Adaptive confidence threshold based on feedback history."""
        base = 0.65  # lowered from 0.75 — new templates need a generous starting threshold
        total = (self.confirm_count or 0) + (self.reject_count or 0)
        if total < 5:
            return base
        precision = (self.confirm_count or 0) / total
        if precision > 0.9:
            return max(0.55, base - 0.08)   # high precision → find more
        elif precision < 0.6:
            return min(0.82, base + 0.08)   # low precision → be stricter
        return base

    @property
    def quality_score(self) -> float:
        """Score used to rank templates; untested templates get neutral 0.5."""
        if not self.use_count:
            return 0.5
        return (self.confirm_count or 0) / max(self.use_count, 1)


# ── Detection feedback ────────────────────────────────────────────────────────
class DetectionFeedback(Base):
    """
    Records every correction made during verification.
    - 'confirm'       : auto-detected and user kept it (true positive)
    - 'false_positive': auto-detected and user deleted it
    - 'missed'        : user manually added it (was not auto-detected)
    - 'wrong_type'    : detected as one type, user corrected to another
    """
    __tablename__ = "detection_feedback"
    id                  = Column(Integer, primary_key=True, index=True)
    symbol_code         = Column(String, nullable=False, index=True)
    feedback_type       = Column(String, nullable=False)
    image_path          = Column(String, default="")
    img_x               = Column(Float, default=0.0)
    img_y               = Column(Float, default=0.0)
    original_confidence = Column(Float, nullable=True)
    original_method     = Column(String, default="")
    corrected_code      = Column(String, nullable=True)
    drawing_firm        = Column(String, default="")
    drawing_scale       = Column(String, default="")
    template_id         = Column(Integer, ForeignKey("global_templates.id"), nullable=True)
    drawing_id          = Column(Integer, ForeignKey("drawings.id"), nullable=True)
    page_number         = Column(Integer, default=1)
    created_at          = Column(DateTime(timezone=True), server_default=func.now())
    template            = relationship("GlobalTemplate", back_populates="feedbacks")


# ── Project ───────────────────────────────────────────────────────────────────
class ProjectSymbolType(Base):
    __tablename__ = "project_symbol_types"
    __table_args__ = (UniqueConstraint("project_id", "code", name="uq_project_code"),)
    id           = Column(Integer, primary_key=True, index=True)
    name         = Column(String, nullable=False)
    code         = Column(String, nullable=False)
    color        = Column(String, default="#8892a8")
    sort_order   = Column(Integer, default=0)
    project_id   = Column(Integer, ForeignKey("projects.id"))
    project      = relationship("Project", back_populates="symbol_types")


class Project(Base):
    __tablename__ = "projects"
    id            = Column(Integer, primary_key=True, index=True)
    name          = Column(String, nullable=False)
    client        = Column(String, default="")
    site          = Column(String, default="")
    description   = Column(Text, default="")
    drawing_firm  = Column(String, default="")
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    updated_at    = Column(DateTime(timezone=True), onupdate=func.now())
    owner_id      = Column(Integer, ForeignKey("users.id"))
    owner         = relationship("User", back_populates="projects")
    drawings      = relationship("Drawing", back_populates="project", cascade="all, delete-orphan")
    symbol_types  = relationship("ProjectSymbolType", back_populates="project",
                                 cascade="all, delete-orphan", order_by="ProjectSymbolType.sort_order")


# ── Drawing ───────────────────────────────────────────────────────────────────
class Drawing(Base):
    __tablename__ = "drawings"
    id             = Column(Integer, primary_key=True, index=True)
    filename       = Column(String, nullable=False)
    original_name  = Column(String, nullable=False)
    block          = Column(String, default="")
    level          = Column(String, default="")
    revision       = Column(String, default="")
    total_pages    = Column(Integer, default=1)
    # Status: uploaded → processing → detected → verified → approved
    status         = Column(String, default="uploaded")
    error_message  = Column(Text, nullable=True)   # populated when status == "error"
    verified_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    verified_at    = Column(DateTime(timezone=True), nullable=True)
    approved_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    approved_at    = Column(DateTime(timezone=True), nullable=True)
    created_at     = Column(DateTime(timezone=True), server_default=func.now())
    updated_at     = Column(DateTime(timezone=True), onupdate=func.now())
    project_id     = Column(Integer, ForeignKey("projects.id"))
    project        = relationship("Project", back_populates="drawings")
    pages          = relationship("DrawingPage", back_populates="drawing", cascade="all, delete-orphan")

    @property
    def total_counts(self):
        counts = {}
        for page in self.pages:
            for det in (page.detections or []):
                t = det.get("type", "")
                counts[t] = counts.get(t, 0) + 1
        return counts


class DrawingPage(Base):
    __tablename__ = "drawing_pages"
    id                  = Column(Integer, primary_key=True, index=True)
    page_number         = Column(Integer, nullable=False)
    image_path          = Column(String, nullable=False)
    detections          = Column(JSON, default=list)           # user-verified
    original_detections = Column(JSON, default=list)           # immutable auto-detected copy
    verified            = Column(Boolean, default=False)
    drawing_id          = Column(Integer, ForeignKey("drawings.id"))
    drawing             = relationship("Drawing", back_populates="pages")
